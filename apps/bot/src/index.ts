import {
  Client,
  GatewayIntentBits,
  Collection,
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import express from "express";
import { botEnvironment } from "./config/runtime";
import { createHealthRouter } from "./routes/HealthRouter";
import cors from "cors";
import http from "http";
import { logger } from "./utils/logger";
import { authMiddleware, requireGuildAdmin } from "./middleware/auth";
import { supabase } from "./lib/supabase";
import { tBot, getGuildLanguage } from "./i18n";
import { SchedulerService } from "./services/SchedulerService";
import { SchedulerRecovery } from "./services/SchedulerRecovery";
import { ScoreService } from "./services/ScoreService";
import { RegistrationService } from "./services/RegistrationService";
import { WebhookRolesService } from "./services/WebhookRolesService";
import { applyPresence, hasPresenceFailure } from "./services/CaptainPresenceService";
import { GuildRegistryService, readToRoleId } from "./services/GuildRegistryService";
import { resolveAdminReason } from "./utils/adminAccess";
import { phaseRouter } from "./routes/PhaseRouter";
import { matchRouter } from "./routes/MatchRouter";
import { tournamentRouter } from "./routes/TournamentRouter";
import { teamRouter } from "./routes/TeamRouter";
import { serverSettingsRouter } from "./routes/ServerSettingsRouter";
import { archiveAndInit, syncSchedule } from "./routes/LifecycleRouter";

// Importer les commandes locales
import * as adminTransferCommand from "./commands/admin-transfer";
import * as adminSetupCheckinCommand from "./commands/admin-setup-checkin";
import * as scoreCommand from "./commands/score";

const PORT = botEnvironment.PORT;
const DISCORD_TOKEN = botEnvironment.DISCORD_TOKEN;

// Collections pour stocker nos commandes
const commands = new Collection<string, any>();
commands.set(adminTransferCommand.data.name, adminTransferCommand);
commands.set(adminSetupCheckinCommand.data.name, adminSetupCheckinCommand);
commands.set(scoreCommand.data.name, scoreCommand);

// 1. Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// Discord client error handlers
client.on("error", (err) => logger.error("[Discord] Client error:", err));
client.on("warn", (info) => logger.warn("[Discord] Client warning:", info));

// 2. Initialize Express Server
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || false }));

// Apply authentication middleware to all API routes
app.use("/api", authMiddleware);

// Inject client globally
app.locals.discordClient = client;

const guildAdminGuard = requireGuildAdmin(client);

// Health check (no auth required — skipped in middleware)
const schedulerRecovery = new SchedulerRecovery(
  () => SchedulerService.init(client),
  (error) => logger.error("[Scheduler] Restoration failed; retrying", error),
);
app.use(createHealthRouter(() => client.isReady(), async () => {
  if (!schedulerRecovery.isReady()) return false;
  const { error } = await supabase.from("server_settings").select("guild_id").limit(1)
    .abortSignal(AbortSignal.timeout(3000));
  return !error;
}));

// Webhook endpoint for Supabase Database Webhooks (no auth required - secured by signature/secret)
app.post("/api/webhook/team-update", async (req, res) => {
  try {
    const webhookSecret = process.env.WEBHOOK_SECRET || process.env.BOT_API_SECRET;
    if (!webhookSecret) {
      logger.error("[Webhook] Secret non configuré dans l'environnement");
      return res.status(500).json({ error: "Server authentication misconfiguration" });
    }

    const receivedSecret = req.headers["x-webhook-secret"] || req.query.secret;
    if (receivedSecret !== webhookSecret) {
      return res.status(401).json({ error: "Unauthorized: Invalid webhook secret" });
    }

    const webhookService = new WebhookRolesService(client);
    const result = await webhookService.handleTeamUpdate(req.body);

    if (result.success) {
      res.status(200).json({ received: true });
    } else {
      res.status(500).json({ received: false, error: result.error });
    }
  } catch (error: any) {
    logger.error("Error handling team update webhook:", error);
    res.status(500).json({
      received: false,
      error: error?.message || "Failed to handle webhook"
    });
  }
});

// Endpoint: Fetch Roles for the connected Discord Guild
app.get("/api/discord/roles", guildAdminGuard, async (req, res) => {
  const guildId = (req.query.guildId || req.body?.guildId) as string;
  if (!guildId) {
    return res.status(400).json({ error: "Missing guildId parameter." });
  }

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res
        .status(404)
        .json({ error: "Guild not found. Ensure bot is in the server." });
    }

    const rolesInfo = guild.roles.cache
      .filter((role) => role.name !== "@everyone")
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    return res.status(200).json(rolesInfo);
  } catch (error) {
    logger.error("Error fetching roles:", error);
    return res.status(500).json({ error: "Failed to fetch roles." });
  }
});

// Endpoint: Ordonne au client Discord de créer/supprimer des salons/rôles!
app.post("/api/discord/publish-phase", guildAdminGuard, async (_req, res) => {
  try {
    res.status(202).json({ message: "Phase publish triggered." });
  } catch (error) {
    res.status(500).json({ error: "Failed to publish phase on Discord." });
  }
});

const getGuild = async (res: any, guildId: string): Promise<any> => {
  if (!guildId) {
    res.status(400).json({ error: "Missing guildId parameter" });
    return null;
  }
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    res.status(404).json({ error: "Guild not found. Ensure bot is in the server." });
    return null;
  }
  return guild;
};

// Endpoint: Vérifier si un membre a les droits d'admin/TO sur un serveur (appel serveur Next.js uniquement :
// le proxy /api/bot ne relaie pas cette route, cf. SEC-13). Le rôle TO est relu en base, jamais pris du client.
app.get("/api/discord/permissions", async (req, res) => {
  const guildId = typeof req.query.guildId === "string" ? req.query.guildId : "";
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  if (!guildId || !userId) return res.status(400).json({ error: "Missing parameters" });

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(200).json({ hasPermission: false, reason: "BOT_NOT_IN_GUILD" });

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return res.status(200).json({ hasPermission: false, reason: "NOT_A_MEMBER" });

    const settings = await readToRoleId(guildId);
    if (!settings.ok) return res.status(503).json({ error: "Permission check temporarily unavailable" });

    const reason = resolveAdminReason({
      isOwner: guild.ownerId === userId,
      hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
      hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
      hasToRole: !!settings.toRoleId && member.roles.cache.has(settings.toRoleId),
    });
    return res.status(200).json({ hasPermission: reason !== null, reason: reason ?? "NO_RIGHTS" });
  } catch (error) {
    logger.error("Error checking permissions:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint: Fetch Channels for Check-in configurations
app.get("/api/discord/channels", guildAdminGuard, async (req, res) => {
  try {
    const guildId = (req.query.guildId || req.body?.guildId) as string;
    const guild = await getGuild(res, guildId);
    if (!guild) return;

    const channelsInfo = guild.channels.cache
      .filter((channel: any) => channel.isTextBased())
      .map((channel: any) => ({
        id: channel.id,
        name: channel.name,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    return res.status(200).json(channelsInfo);
  } catch (error) {
    logger.error("Error fetching channels:", error);
    return res.status(500).json({ error: "Failed to fetch channels." });
  }
});

// Endpoint: Fetch Guild Members for Manual Input Combobox
app.get("/api/discord/members", guildAdminGuard, async (req, res) => {
  try {
    const guildId = (req.query.guildId || req.body?.guildId) as string;
    const guild = await getGuild(res, guildId);
    if (!guild) return;

    const members = await guild.members.fetch({ limit: 1000 });

    const membersInfo = Array.from(members.values())
      .filter((member: any) => !member.user.bot)
      .map((member: any) => ({
        id: member.user.id,
        username: member.user.username,
        displayName: member.displayName,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return res.status(200).json(membersInfo);
  } catch (error) {
    logger.error("Error fetching members:", error);
    return res.status(500).json({ error: "Failed to fetch members." });
  }
});

// Endpoint: Auto-setup for Checkin requirements
app.post("/api/discord/auto-setup", guildAdminGuard, async (req, res) => {
  try {
    const guildId = (req.query.guildId || req.body?.guildId) as string;
    const guild = await getGuild(res, guildId);
    if (!guild) return;

    const lang = await getGuildLanguage(guildId);
    const captainRole = await guild.roles.create({
      name: tBot(lang, "autoSetup.captainRoleName"),
      color: 0xffa500,
      reason: tBot(lang, "autoSetup.auditReason"),
    });

    const checkinChannel = await guild.channels.create({
      name: tBot(lang, "autoSetup.checkinChannelName"),
      type: ChannelType.GuildText,
      reason: tBot(lang, "autoSetup.auditReason"),
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: captainRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ],
        },
      ],
    });

    return res.status(200).json({
      message: "Setup généré avec succès !",
      captain_role_id: captainRole.id,
      checkin_channel_id: checkinChannel.id,
    });
  } catch (error) {
    logger.error("Erreur durant l'auto-setup Discord:", error);
    return res
      .status(500)
      .json({ error: "Échec de l'auto-setup sur Discord." });
  }
});

// Lifecycle routes: authenticate the guild before loading or changing a tournament.
app.post('/api/discord/sync-schedule', guildAdminGuard, syncSchedule);
app.post('/api/tournaments/archive-and-init', guildAdminGuard, archiveAndInit);

// Mutation routes: protected by authMiddleware + requireGuildAdmin (live Discord perm check)
app.use('/api/phases', guildAdminGuard, phaseRouter);
app.use('/api/matches', guildAdminGuard, matchRouter);
app.use('/api/tournaments', guildAdminGuard, tournamentRouter);
app.use('/api/teams', guildAdminGuard, teamRouter);
app.use('/api/server-settings', guildAdminGuard, serverSettingsRouter);

// 3. Connect DB and Start Systems
let server: http.Server;

const bootstrap = async () => {
  // Global error handlers
  process.on("unhandledRejection", (reason) => {
    logger.error("[Process] Unhandled Rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    logger.error("[Process] Uncaught Exception:", err);
    process.exit(1);
  });

  try {
    // Droits back-office : guild_admins suit les membres, leurs rôles et leurs permissions (DISC-08).
    client.on('guildMemberRemove', async (member) => {
      await GuildRegistryService.removeMember(member.guild.id, member.user.id);
    });

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
      const oldRoleIds = new Set(oldMember.roles.cache.keys());
      const newRoleIds = new Set(newMember.roles.cache.keys());
      const rolesChanged =
        oldRoleIds.size !== newRoleIds.size ||
        [...newRoleIds].some(id => !oldRoleIds.has(id));
      if (!rolesChanged && !oldMember.partial) return;

      const settings = await readToRoleId(newMember.guild.id);
      if (!settings.ok) return;
      await GuildRegistryService.syncMemberAdmin(newMember.guild, newMember, settings.toRoleId);
    });

    // Un rôle peut gagner ou perdre Administrateur / Gérer le serveur sans qu'aucun membre ne change de rôle.
    client.on('roleUpdate', async (oldRole, newRole) => {
      if (oldRole.permissions.bitfield === newRole.permissions.bitfield) return;
      await GuildRegistryService.syncGuildAdmins(newRole.guild);
    });

    // Cycle de vie des serveurs : la ligne server_settings rend le serveur visible sur le web (DISC-07).
    client.on("guildCreate", async (guild) => {
      if (await GuildRegistryService.registerGuild(guild)) {
        await GuildRegistryService.syncGuildAdmins(guild);
      }
    });
    client.on("guildUpdate", async (_oldGuild, newGuild) => {
      await GuildRegistryService.registerGuild(newGuild);
    });
    client.on("guildDelete", async (guild) => {
      await GuildRegistryService.markGuildLeft(guild.id);
    });

    // Rattrapage au démarrage : serveurs rejoints ou modifiés pendant que le bot était hors ligne.
    // Attendre ClientReady : avant, le cache ne contient que des serveurs indisponibles (sans nom ni membres).
    client.once(Events.ClientReady, async (readyClient) => {
      for (const guild of readyClient.guilds.cache.values()) {
        if (await GuildRegistryService.registerGuild(guild)) {
          await GuildRegistryService.syncGuildAdmins(guild);
        }
      }
    });

    // Connect Discord Bot
    await client.login(DISCORD_TOKEN);
    logger.info(`[Bot] Logged in as ${client.user?.tag}`);


    // Start Tournament Scheduler
    void schedulerRecovery.start();

    // Initialize Webhook Roles Service
    // This service handles team updates via Supabase Database Webhooks
    // No initialization needed - it just handles incoming webhook requests
    logger.info("[Bot] Using WebhookRolesService (webhook-based)");
    logger.info("[Bot] Webhook endpoint: /api/webhook/team-update");
    logger.info("[Bot] Make sure to configure Supabase Database Webhooks to send events to this endpoint");

    // Handle Discord interactions
    client.on("interactionCreate", async (interaction) => {
      try { await RegistrationService.handleInteraction(interaction); } catch(e) { logger.error('Registration Error', e); }

      // -- STRING SELECT MENUS --
      if (interaction.isStringSelectMenu() && interaction.customId === 'select_match_to_score') {
        try {
          await ScoreService.handleSelectMenu(interaction);
        } catch (e: any) {
          logger.error("SelectMenu Error", e);
        }
        return;
      }

      // -- MODALS --
      if (interaction.isModalSubmit()) {
        try {
          await ScoreService.handleModalSubmit(interaction);
        } catch (e: any) {
          logger.error("Modal Error", e);
        }
        return;
      }

      // -- BUTTONS --
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("btn_score_")) {
          try {
            await ScoreService.handleButton(interaction);
          } catch (e) {
            logger.error("Button Score Error", e);
          }
          return;
        }

        if (interaction.customId === "btn_checkin") {
          try {
            const guildId = interaction.guildId;
            const captainId = interaction.user.id;

            const { data: currentTournament } = await supabase
              .from("tournaments")
              .select("id")
              .eq("guild_id", guildId)
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            const lang = await getGuildLanguage(guildId, currentTournament?.id);

            if (!currentTournament) {
              return interaction.reply({
                content: tBot(lang, "checkin.noTournament"),
                ephemeral: true,
              });
            }

            const { data: team } = await supabase
              .from("teams")
              .select("id, name, is_checked_in")
              .eq("tournament_id", currentTournament.id)
              .eq("captain_discord_id", captainId)
              .single();

            if (!team) {
              return interaction.reply({
                content: tBot(lang, "checkin.notCaptain"),
                ephemeral: true,
              });
            }

            if (team.is_checked_in) {
              return interaction.reply({
                content: tBot(lang, "checkin.alreadyCheckedIn", { teamName: team.name }),
                ephemeral: true,
              });
            }

            const { error: updateError } = await supabase
              .from("teams")
              .update({ is_checked_in: true })
              .eq("id", team.id);

            if (updateError) {
              logger.error("Failed to check in team:", updateError);
              return interaction.reply({
                content: tBot(lang, "checkin.dbError"),
                ephemeral: true,
              });
            }

            await interaction.reply({
              content: tBot(lang, "checkin.success", { teamName: team.name }),
              ephemeral: true,
            });

            // DISC-11 : présence appliquée directement (sans dépendre du webhook Supabase), après la réponse (DISC-01).
            const presence = await applyPresence(client, {
              id: team.id,
              tournament_id: currentTournament.id,
              name: team.name,
              captain_discord_id: captainId,
            });
            if (hasPresenceFailure(presence)) {
              await interaction.followUp({
                content: tBot(lang, "checkin.presenceIncomplete"),
                ephemeral: true,
              });
            }
            return;
          } catch (err: any) {
            logger.error("Check-in interaction error", err);
          }
        }
        return;
      }

      if (!interaction.isChatInputCommand() && !interaction.isAutocomplete())
        return;

      const command = commands.get(interaction.commandName);
      if (!command) return;

      if (interaction.isAutocomplete()) {
        try {
          if (typeof command.autocomplete === "function") {
            await command.autocomplete(interaction);
          }
        } catch (error) {
          logger.error(error);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      try {
        await command.execute(interaction);
      } catch (error) {
        logger.error(error);
        const lang = await getGuildLanguage(interaction.guildId);
        await interaction.reply({
          content: tBot(lang, "common.commandError"),
          ephemeral: true,
        });
      }
    });

    // Start Express Web API
    server = app.listen(PORT, () => {
      logger.info(`[API] Express listening on port ${PORT}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`[Process] Received ${signal}, shutting down gracefully...`);
      schedulerRecovery.stop();
      SchedulerService.cancelAllJobs();

      if (server) {
        server.close(() => {
          logger.info("[API] HTTP server closed");
        });
      }

      client.destroy();
      logger.info("[Discord] Client destroyed");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

bootstrap();
