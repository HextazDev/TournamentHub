import schedule from "node-schedule";
import {
  type Client,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { supabase } from "../lib/supabase";
import { tBot, getGuildLanguage } from "../i18n";
import { logger } from "../utils/logger";
import { resolveActiveDiscordGuild } from "../utils/tenant";
import type { Tournament } from "@hub/shared";

export type SchedulableTournament = Pick<Tournament, "id"> &
  Partial<Pick<Tournament, "checkin_mode" | "checkin_start_at" | "checkin_end_at" | "guild_id" | "status">>;

export class SchedulerService {
  private static activeJobs: Map<string, schedule.Job> = new Map();
  private static client: Client;

  public static async init(client: Client) {
    this.client = client;
    logger.info("[Scheduler] Initializing SchedulerService...");

    const { data: tournaments, error } = await supabase
      .from("tournaments")
      .select("*")
      .in("status", ["REGISTRATION", "ACTIVE"])
      .gte("checkin_end_at", new Date().toISOString())
      .abortSignal(AbortSignal.timeout(10_000));

    if (error) {
      throw new Error("Failed to load active tournaments", { cause: error });
    }

    if (tournaments && tournaments.length > 0) {
      logger.info(`[Scheduler] Found ${tournaments.length} active tournaments to schedule.`);
      for (const t of tournaments) {
        if (t.checkin_start_at && t.checkin_end_at) {
          this.scheduleTournament(t);
        }
      }
    }
  }

  public static async scheduleTournament(tournament: SchedulableTournament) {
    this.cancelTournamentJobs(tournament.id);

    // CHK-05 (#15) : si checkin_mode === "DISABLED", aucun job de check-in et toutes les équipes sont prêtes
    if (tournament.checkin_mode === "DISABLED") {
      const { error } = await supabase
        .from("teams")
        .update({ is_checked_in: true })
        .eq("tournament_id", tournament.id)
        .eq("is_checked_in", false);

      if (error) {
        logger.error(`[Scheduler] Failed to auto-checkin teams for tournament ${tournament.id}:`, error);
      } else {
        logger.info(`[Scheduler] Tournament ${tournament.id} has checkin DISABLED, all registered teams marked checked in.`);
      }
      return;
    }

    if (!tournament.checkin_start_at || !tournament.checkin_end_at) {
      return;
    }

    const now = new Date();
    const startAt = new Date(tournament.checkin_start_at);
    const endAt = new Date(tournament.checkin_end_at);

    // --- Open Check-in ---
    if (now < startAt) {
      const openJob = schedule.scheduleJob(startAt, async () => {
        await this.handleOpenCheckin(tournament.id);
      });
      this.activeJobs.set(`${tournament.id}_open`, openJob);
    } else if (now >= startAt && now < endAt) {
      // Catch-up: check-in window already started
      // Refresh from DB to get the latest checkin_message_id
      this.catchUpCheckin(tournament.id).catch((err) =>
        logger.error(`[Scheduler] Catch-up failed for ${tournament.id}:`, err)
      );
    }

    // --- Reminders ---
    const diffMs = endAt.getTime() - startAt.getTime();
    const durationMin = Math.floor(diffMs / 60000);

    if (durationMin >= 30) {
      const remind30Time = new Date(endAt.getTime() - 30 * 60000);
      if (now < remind30Time) {
        const remind30Job = schedule.scheduleJob(remind30Time, async () => {
          await this.handleReminders(tournament.id, 30);
        });
        this.activeJobs.set(`${tournament.id}_remind30`, remind30Job);
      }
    }

    if (durationMin >= 10) {
      const remind10Time = new Date(endAt.getTime() - 10 * 60000);
      if (now < remind10Time) {
        const remind10Job = schedule.scheduleJob(remind10Time, async () => {
          await this.handleReminders(tournament.id, 10);
        });
        this.activeJobs.set(`${tournament.id}_remind10`, remind10Job);
      }
    }

    // --- Close Check-in ---
    if (now < endAt) {
      const closeJob = schedule.scheduleJob(endAt, async () => {
        await this.handleCloseCheckin(tournament.id);
      });
      this.activeJobs.set(`${tournament.id}_close`, closeJob);
    }

    logger.info(
      `[Scheduler] Programmed check-in jobs for tournament ${tournament.id} (Open: ${startAt.toISOString()}, Close: ${endAt.toISOString()})`,
    );
  }

  public static cancelTournamentJobs(tournamentId: string) {
    const jobKeys = [
      `${tournamentId}_open`,
      `${tournamentId}_remind30`,
      `${tournamentId}_remind10`,
      `${tournamentId}_close`,
    ];
    for (const key of jobKeys) {
      const job = this.activeJobs.get(key);
      if (job) {
        job.cancel();
        this.activeJobs.delete(key);
      }
    }
  }

  public static cancelAllJobs() {
    for (const [key, job] of this.activeJobs.entries()) {
      job.cancel();
      this.activeJobs.delete(key);
    }
    logger.info("[Scheduler] All jobs cancelled.");
  }

  // ============== HANDLERS ==============

  private static async catchUpCheckin(tournamentId: string) {
    const { data: tournament } = await supabase
      .from("tournaments")
      .select("id, organization_id, checkin_message_id, discord_checkin_channel_id")
      .eq("id", tournamentId)
      .single();

    if (!tournament) return;
    if (!(await resolveActiveDiscordGuild(tournament.organization_id))) return;

    // Already has a message ID — the embed was published, skip
    if (tournament.checkin_message_id) {
      logger.info(`[Scheduler] Check-in already triggered for ${tournamentId}, resuming reminders and close jobs.`);
      return;
    }

    // No message ID — but maybe the message was sent and the ID wasn't saved (crash before DB write).
    // Check if the bot already sent a recent message in the check-in channel.
    if (tournament.discord_checkin_channel_id) {
      const alreadySent = await this.botAlreadySentCheckinMessage(tournament.discord_checkin_channel_id, tournamentId);
      if (alreadySent) {
        logger.info(`[Scheduler] Catch-up: bot already sent a check-in message in channel ${tournament.discord_checkin_channel_id}. Updating DB and skipping.`);
        // Save the message ID so future restarts won't re-trigger
        await supabase
          .from("tournaments")
          .update({ checkin_message_id: alreadySent })
          .eq("id", tournamentId);
        return;
      }
    }

    // No message found — genuinely missed, send it now
    logger.info(`[Scheduler] Catch-up: Starting missed check-in for tournament ${tournamentId} immediately.`);
    await this.handleOpenCheckin(tournamentId);
  }

  private static async botAlreadySentCheckinMessage(channelId: string, _tournamentId: string): Promise<string | null> {
    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return null;

      const messages = await channel.messages.fetch({ limit: 10 });
      const botId = this.client.user?.id;
      if (!botId) return null;

      for (const [msgId, msg] of messages) {
        if (msg.author.id !== botId) continue;
        if (!msg.components || msg.components.length === 0) continue;

        for (const row of msg.components) {
          if (!row || !("components" in row)) continue;
          for (const component of (row as any).components) {
            if (component?.customId === "btn_checkin" || component?.data?.custom_id === "btn_checkin") {
              return msgId;
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Scheduler] Failed to check existing messages in channel ${channelId}:`, err);
    }
    return null;
  }

  private static async handleOpenCheckin(tournamentId: string) {
    try {
      logger.info(`[Scheduler] Executing Check-in Open for tournament ${tournamentId}`);

      // Always fetch fresh tournament data
      const { data: tournament } = await supabase
        .from("tournaments")
        .select("*")
        .eq("id", tournamentId)
        .single();

      if (!tournament) return;
      // CHK-01 : la fenêtre de check-in vit en base ; sans intégration active, rien n'est publié sur Discord.
      const guildId = await resolveActiveDiscordGuild(tournament.organization_id);
      if (!guildId) return;

      // Double-check: if message already exists, skip
      if (tournament.checkin_message_id) {
        logger.info(`[Scheduler] Check-in message already exists for ${tournamentId}, skipping.`);
        return;
      }

      const checkinChannelId = tournament.discord_checkin_channel_id;
      const captainRoleId = tournament.discord_captain_role_id;

      if (!checkinChannelId) {
        logger.warn(`[Scheduler] Missing discord_checkin_channel_id for tournament ${tournamentId}`);
        return;
      }

      const channel = (await this.client.channels.fetch(checkinChannelId)) as TextChannel;
      if (!channel || !("send" in channel)) return;

      const lang = await getGuildLanguage(guildId, tournamentId);
      const mentionsMessage = captainRoleId
        ? tBot(lang, "checkin.openMention", { role: `<@&${captainRoleId}>` })
        : tBot(lang, "checkin.openNoMention");

      const checkinEmbed = new EmbedBuilder()
        .setTitle(tBot(lang, "checkin.openTitle"))
        .setDescription(
          tBot(lang, "checkin.openDescription", {
            name: tournament.name,
            closesAt: `<t:${Math.floor(new Date(tournament.checkin_end_at).getTime() / 1000)}:R>`,
          }),
        )
        .setColor(0x00ff00);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("btn_checkin")
          .setLabel(tBot(lang, "checkin.validateButton"))
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅"),
      );

      const msg = await channel.send({
        content: mentionsMessage,
        embeds: [checkinEmbed],
        components: [row],
      });

      // Save message ID immediately
      await supabase
        .from("tournaments")
        .update({ checkin_message_id: msg.id })
        .eq("id", tournamentId);

      logger.info(`[Scheduler] Check-in Embed published and checkin_message_id saved for ${tournamentId}.`);
    } catch (e) {
      logger.error("[Scheduler] Failed opening checkin:", e);
    }
  }

  private static async handleReminders(tournamentId: string, minutesLeft: number) {
    try {
      logger.info(`[Scheduler] Warning: Check-in closes in ${minutesLeft}min for tournament ${tournamentId}`);

      // Fetch fresh tournament data
      const { data: tournament } = await supabase
        .from("tournaments")
        .select("organization_id, discord_checkin_channel_id")
        .eq("id", tournamentId)
        .single();

      if (!tournament?.discord_checkin_channel_id) return;
      const guildId = await resolveActiveDiscordGuild(tournament.organization_id);
      if (!guildId) return;

      const { data: teams } = await supabase
        .from("teams")
        .select("captain_discord_id")
        .eq("tournament_id", tournamentId)
        .eq("is_checked_in", false);

      if (!teams || teams.length === 0) return;

      const channel = (await this.client.channels.fetch(tournament.discord_checkin_channel_id)) as TextChannel;
      if (!channel || !("send" in channel)) return;

      const lang = await getGuildLanguage(guildId, tournamentId);
      const mentions = teams.map((t) => `<@${t.captain_discord_id}>`).join(" ");
      await channel.send(tBot(lang, "checkin.reminder", { minutes: minutesLeft, mentions }));
    } catch (e) {
      logger.error("[Scheduler] Failed sending reminders:", e);
    }
  }

  public static async handleCloseCheckin(tournamentId: string) {
    try {
      logger.info(`[Scheduler] Closing checkin for tournament ${tournamentId}`);

      const { data: latestTournament } = await supabase
        .from("tournaments")
        .select("organization_id, checkin_message_id, discord_checkin_channel_id")
        .eq("id", tournamentId)
        .single();

      if (!latestTournament?.checkin_message_id) return;
      const guildId = await resolveActiveDiscordGuild(latestTournament.organization_id);
      if (!guildId) return;

      const checkinChannelId = latestTournament.discord_checkin_channel_id;
      if (!checkinChannelId) return;

      const channel = (await this.client.channels.fetch(checkinChannelId)) as TextChannel;
      if (!channel || !("messages" in channel)) return;

      const msg = await channel.messages.fetch(latestTournament.checkin_message_id).catch(() => null);
      if (msg) {
        const lang = await getGuildLanguage(guildId, tournamentId);
        const checkinEmbed = new EmbedBuilder()
          .setTitle(tBot(lang, "checkin.closedTitle"))
          .setDescription(tBot(lang, "checkin.closedDescription"))
          .setColor(0xff0000);

        await msg.edit({
          content: tBot(lang, "checkin.closedContent"),
          embeds: [checkinEmbed],
          components: [],
        });
      }
    } catch (e) {
      logger.error("[Scheduler] Failed closing checkin:", e);
    }
  }
}
