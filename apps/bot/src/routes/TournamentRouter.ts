import { Router } from "express";
import { supabase } from "../lib/supabase";
import { RegistrationService } from "../services/RegistrationService";
import { LifecycleService } from "../services/LifecycleService";
import { SchedulerService } from "../services/SchedulerService";
import { getAuthenticatedGuildId, resolveOrganization, verifyTournamentGuild } from "../utils/tenant";
import { canPerform, LocaleSchema, CheckinModeSchema } from "@hub/shared";
import { sendServerError } from "../utils/serverError";
import { requireServerLevel, requireTournamentScope, tournamentFrom } from "../middleware/auth";
import { refreshGuildAccess } from "../services/AccessRefreshService";
import { ChannelAccessService } from "../services/ChannelAccessService";
import { IntegrationBus } from "../services/IntegrationBus";
import { logger } from "../utils/logger";

const OptionalLocaleSchema = LocaleSchema.optional();

export const tournamentRouter = Router();

// SEC-21 : chaque route déclare sa garde (montage ouvert aux TO de tournoi) ; la création reste au niveau SERVER.
const tournamentScope = requireTournamentScope(tournamentFrom.param("id"));

/** Un champ de rôle est modifié s'il est fourni et diffère de la valeur enregistrée (vide = aucun rôle). */
function roleChanged(requested: unknown, current: string | null): boolean {
  return requested !== undefined && (requested || null) !== current;
}

async function safeResolveOrg(identifier: string) {
  return resolveOrganization(identifier);
}

// POST /api/tournaments — Create a new tournament (defaults to DRAFT)
tournamentRouter.post("/", requireServerLevel, async (req, res) => {
  try {
    const {
      guild_id, organization_id, organizationId, name, description, start_at,
      checkin_start_at, checkin_end_at,
      discord_registration_channel_id, discord_announcement_channel_id,
      discord_checkin_channel_id, discord_captain_role_id, discord_to_role_id,
      guildId,
    } = req.body;

    const effectiveGuildId = guild_id || guildId || organization_id || organizationId;
    const authGuildId = getAuthenticatedGuildId(req);

    if (!authGuildId || (effectiveGuildId && effectiveGuildId !== authGuildId)) {
      return res.status(403).json({ error: "Accès refusé : vous ne pouvez créer un tournoi que sur votre propre serveur." });
    }

    const targetGuildId = effectiveGuildId || authGuildId;
    if (!targetGuildId || !name) {
      return res.status(400).json({ error: "guild_id and name are required" });
    }

    const requestedLanguage = OptionalLocaleSchema.safeParse(req.body.language);
    if (!requestedLanguage.success) {
      return res.status(400).json({ error: "language must be 'fr' or 'en'" });
    }

    const org = await safeResolveOrg(targetGuildId);

    // Fetch server default settings
    const { data: serverSettings, error: settingsError } = await supabase
      .from("server_settings")
      .select("*")
      .eq("guild_id", targetGuildId)
      .maybeSingle();
    if (settingsError) throw settingsError;

    const discordCfg = org?.discordConfig ?? {};
    const insertPayload: Record<string, unknown> = {
      guild_id: org ? (org.discordGuildId ?? targetGuildId) : targetGuildId,
      ...(org ? { organization_id: org.id } : {}),
      name,
      description: description || null,
      game_type: req.body.game_type || "GENERIC",
      status: "DRAFT",
      start_at: start_at || null,
      checkin_start_at: checkin_start_at || null,
      checkin_end_at: checkin_end_at || null,
      discord_registration_channel_id:
        discord_registration_channel_id ||
        (typeof discordCfg.registration_channel_id === "string" ? discordCfg.registration_channel_id : null) ||
        serverSettings?.registration_channel_id ||
        null,
      discord_announcement_channel_id:
        discord_announcement_channel_id ||
        (typeof discordCfg.announcement_channel_id === "string" ? discordCfg.announcement_channel_id : null) ||
        serverSettings?.announcement_channel_id ||
        null,
      discord_checkin_channel_id:
        discord_checkin_channel_id ||
        (typeof discordCfg.checkin_channel_id === "string" ? discordCfg.checkin_channel_id : null) ||
        serverSettings?.checkin_channel_id ||
        null,
      discord_captain_role_id:
        discord_captain_role_id ||
        (typeof discordCfg.captain_role_id === "string" ? discordCfg.captain_role_id : null) ||
        serverSettings?.captain_role_id ||
        null,
      discord_to_role_id:
        discord_to_role_id ||
        (typeof discordCfg.to_role_id === "string" ? discordCfg.to_role_id : null) ||
        serverSettings?.to_role_id ||
        null,
      language: requestedLanguage.data ?? org?.language ?? serverSettings?.language ?? "fr",
    };

    const { data: created, error } = await supabase
      .from("tournaments")
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    // SEC-05 / DISC-08 : un rôle TO de tournoi ouvre l'accès au panel ; cache invalidé, annuaire resynchronisé.
    if (created?.discord_to_role_id) refreshGuildAccess(req.app.locals.discordClient, targetGuildId);
    res.status(201).json(created);
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.create");
  }
});

// PUT /api/tournaments/:id/settings — Update tournament settings
tournamentRouter.put("/:id/settings", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const {
      start_at, checkin_start_at, checkin_end_at, checkin_mode,
      discord_registration_channel_id, discord_announcement_channel_id,
      discord_checkin_channel_id, discord_captain_role_id, discord_to_role_id,
      language,
    } = req.body;

    // Fetch the current tournament state to check if we transition from DRAFT to REGISTRATION
    const { data: currentTournament, error: fetchErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("id", tournamentId)
      .single();

    if (fetchErr || !currentTournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    let resolvedCheckinMode = currentTournament.checkin_mode ?? "ENABLED";
    if (checkin_mode !== undefined) {
      const parsedMode = CheckinModeSchema.safeParse(checkin_mode);
      if (!parsedMode.success) {
        return res.status(400).json({ error: "checkin_mode must be 'ENABLED' or 'DISABLED'" });
      }
      resolvedCheckinMode = parsedMode.data;
    }

    const requestedLanguage = OptionalLocaleSchema.safeParse(language);
    if (!requestedLanguage.success) {
      return res.status(400).json({ error: "language must be 'fr' or 'en'" });
    }

    // SEC-22 : les rôles du tournoi décident qui le gère ; un TO de tournoi ne peut pas les changer.
    const access = req.adminCheck?.access;
    const canManageRoles = !!access && canPerform(access, "MANAGE_TOURNAMENT_ROLES", tournamentId);
    if (
      !canManageRoles &&
      (roleChanged(discord_to_role_id, currentTournament.discord_to_role_id) ||
        roleChanged(discord_captain_role_id, currentTournament.discord_captain_role_id))
    ) {
      return res.status(403).json({ error: "Tournament roles are reserved to server managers", code: "TOURNAMENT_ROLES_RESERVED" });
    }

    // SEC-21 (#88) : un salon spécifié ou modifié doit être accessible au membre demandeur et au bot.
    const discordId = req.adminCheck?.discordId ?? (req.headers["x-discord-user-id"] as string | undefined);
    const channelChanged = (requested: unknown, current: string | null) =>
      requested !== undefined && (requested || null) !== current && typeof requested === "string" && requested.trim().length > 0;

    const modifiedChannels: string[] = [];
    if (channelChanged(discord_registration_channel_id, currentTournament.discord_registration_channel_id)) {
      modifiedChannels.push(discord_registration_channel_id);
    }
    if (channelChanged(discord_announcement_channel_id, currentTournament.discord_announcement_channel_id)) {
      modifiedChannels.push(discord_announcement_channel_id);
    }
    if (channelChanged(discord_checkin_channel_id, currentTournament.discord_checkin_channel_id)) {
      modifiedChannels.push(discord_checkin_channel_id);
    }

    if (modifiedChannels.length > 0) {
      if (!discordId || !req.app.locals.discordClient) {
        return res.status(403).json({ error: "Access denied: missing Discord client or user", code: "CHANNEL_NOT_ACCESSIBLE" });
      }
      const channelCheck = await ChannelAccessService.validateChannelAccess({
        client: req.app.locals.discordClient,
        guildId: authGuildId,
        discordId,
        channelIds: modifiedChannels,
      });
      if (!channelCheck.ok) {
        return res.status(403).json({ error: channelCheck.error, code: channelCheck.code ?? "CHANNEL_NOT_ACCESSIBLE" });
      }
    }

    let newStatus = currentTournament.status;

    // Transition automatically from DRAFT to REGISTRATION if valid checkin dates are provided or checkin is disabled (#15 / #87 / LIFE-01)
    if (currentTournament.status === "DRAFT") {
      if (resolvedCheckinMode === "DISABLED" || (checkin_start_at && checkin_end_at)) {
        newStatus = "REGISTRATION";
      }
    }

    const payload: any = {
      status: newStatus,
      checkin_mode: resolvedCheckinMode,
      start_at: start_at || null,
      checkin_start_at: resolvedCheckinMode === "DISABLED" ? null : (checkin_start_at || null),
      checkin_end_at: resolvedCheckinMode === "DISABLED" ? null : (checkin_end_at || null),
      discord_registration_channel_id: discord_registration_channel_id || null,
      discord_announcement_channel_id: discord_announcement_channel_id || null,
      discord_checkin_channel_id: resolvedCheckinMode === "DISABLED" ? null : (discord_checkin_channel_id || null),
      // Sans droit sur les rôles, les valeurs enregistrées sont conservées (champ absent ou inchangé).
      discord_captain_role_id: canManageRoles ? discord_captain_role_id || null : currentTournament.discord_captain_role_id,
      discord_to_role_id: canManageRoles ? discord_to_role_id || null : currentTournament.discord_to_role_id,
      language: requestedLanguage.data ?? currentTournament.language,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("tournaments")
      .update(payload)
      .eq("id", tournamentId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Tournament not found" });

    // Schedule/reschedule check-in tasks if status is REGISTRATION
    if (newStatus === "REGISTRATION") {
      try {
        await SchedulerService.scheduleTournament(data);
      } catch (schedErr: unknown) {
        logger.error("[TournamentRouter] Scheduling failed:", schedErr);
      }
    }

    // SEC-05 / DISC-08 : nouveau rôle TO de tournoi : cache invalidé tout de suite,
    // annuaire guild_admins resynchronisé en arrière-plan (la réponse n'attend pas le chargement des membres).
    if (data.discord_to_role_id !== currentTournament.discord_to_role_id) {
      refreshGuildAccess(req.app.locals.discordClient, currentTournament.guild_id);
    }

    res.json(data);
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.updateSettings");
  }
});

// PATCH /api/tournaments/:id/visibility — Toggle is_public
tournamentRouter.patch("/:id/visibility", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { is_public } = req.body;

    if (typeof is_public !== "boolean") {
      return res.status(400).json({ error: "is_public (boolean) is required" });
    }

    const { data, error } = await supabase
      .from("tournaments")
      .update({ is_public })
      .eq("id", tournamentId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Tournament not found" });

    res.json(data);
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.visibility");
  }
});

// /api/tournaments/:id/launch
tournamentRouter.post("/:id/launch", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    // SEC-25 : le serveur visé est le serveur authentifié, jamais un guildId du corps.
    const discordClient = req.app.locals.discordClient;
    const targetGuildId = authGuildId;
    const org = await safeResolveOrg(targetGuildId);

    if (org && !org.discordEnabled) {
      const { error } = await supabase
        .from("tournaments")
        .update({ status: "ACTIVE", updated_at: new Date().toISOString() })
        .eq("id", tournamentId);
      if (error) throw error;
      await IntegrationBus.emit("onTournamentLaunched", {
        organizationId: org.id,
        tournamentId,
        discordClient,
      });
    } else {
      await LifecycleService.launchTournament(tournamentId, org?.discordGuildId ?? targetGuildId, discordClient);
    }
    res.json({ success: true, message: "Tournament launched successfully." });
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.launch");
  }
});

// /api/tournaments/:id/close
tournamentRouter.post("/:id/close", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    // SEC-25 : le serveur visé est le serveur authentifié, jamais un guildId du corps.
    const discordClient = req.app.locals.discordClient;
    const targetGuildId = authGuildId;
    const org = await safeResolveOrg(targetGuildId);

    if (org && !org.discordEnabled) {
      const { error } = await supabase
        .from("tournaments")
        .update({ status: "COMPLETED", updated_at: new Date().toISOString() })
        .eq("id", tournamentId);
      if (error) throw error;
      await IntegrationBus.emit("onTournamentCompleted", {
        organizationId: org.id,
        tournamentId,
        discordClient,
      });
    } else {
      await LifecycleService.closeTournament(tournamentId, org?.discordGuildId ?? targetGuildId, discordClient);
    }
    res.json({ success: true, message: "Tournament closed successfully." });
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.close");
  }
});

// /api/tournaments/:id/registrations
tournamentRouter.post("/:id/registrations", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { action } = req.body;
    const discordClient = req.app.locals.discordClient;
    
    if (action !== 'open') {
      return res.status(400).json({ error: "Unknown registration action" });
    }

    const { data: tournament, error: fetchError } = await supabase
      .from('tournaments')
      .select('start_at, start_date, checkin_start_at, status, discord_registration_channel_id, organization_id')
      .eq('id', tournamentId)
      .single();

    if (fetchError || !tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    // REG-08 : la visibilité web (is_public) n'a pas d'incidence. Un tournoi privé ouvre ses inscriptions
    // aux membres du serveur, puisque l'inscription se fait sur Discord.
    const now = new Date();
    const startDate = tournament.start_at ? new Date(tournament.start_at) : (tournament.start_date ? new Date(tournament.start_date) : null);
    const checkinStart = tournament.checkin_start_at ? new Date(tournament.checkin_start_at) : null;

    if ((checkinStart && now >= checkinStart) || (startDate && now >= startDate) || ['ACTIVE', 'COMPLETED', 'ARCHIVED'].includes(tournament.status)) {
      return res.status(400).json({ error: "Cannot open registrations: The tournament has already reached the check-in phase or has already started." });
    }

    const org = await safeResolveOrg(authGuildId);
    const isWebOnlyRegistration = Boolean(org && !org.discordEnabled && !tournament.discord_registration_channel_id);

    if (!isWebOnlyRegistration) {
      try {
        await RegistrationService.sendRegistrationEmbed(tournamentId, discordClient);
      } catch (embedError: unknown) {
        sendServerError(res, embedError, `TournamentRouter.registrations: annonce d'inscription échouée pour ${tournamentId}`, 502);
        return;
      }
    }

    const { error: flagError } = await supabase
      .from('tournaments')
      .update({ is_registration_open: true })
      .eq('id', tournamentId);
    if (flagError) {
      sendServerError(res, flagError, `TournamentRouter.registrations: ouverture des inscriptions non enregistrée pour ${tournamentId}`);
      return;
    }

    if (org) {
      await IntegrationBus.emit("onRegistrationOpened", {
        organizationId: org.id,
        tournamentId,
        discordClient,
      });
    }

    res.json({ success: true, message: "Registration action executed." });
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.registrations");
  }
});

// POST /api/tournaments/:id/checkin/stop — Stop check-in immediately (Kill Switch)
tournamentRouter.post("/:id/checkin/stop", tournamentScope, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { data: tournament, error: fetchErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("id", tournamentId)
      .single();

    if (fetchErr || !tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    if (tournament.status !== "REGISTRATION") {
      return res.status(400).json({ error: "Check-in is not active (status is not REGISTRATION)." });
    }

    // 1. Cancel memory jobs in Scheduler
    try {
      SchedulerService.cancelTournamentJobs(tournamentId);
    } catch (schedErr) {
      console.error("[TournamentRouter] Failed to cancel scheduled jobs:", schedErr);
    }

    // 2. Perform direct Discord close actions
    try {
      await SchedulerService.handleCloseCheckin(tournamentId);
    } catch (discErr) {
      console.error("[TournamentRouter] Failed to update Discord check-in message:", discErr);
    }

    // 3. Update database
    const now = new Date();
    const { data: updated, error: updateErr } = await supabase
      .from("tournaments")
      .update({
        checkin_end_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", tournamentId)
      .select()
      .single();

    if (updateErr || !updated) {
      throw updateErr || new Error("Failed to update tournament");
    }

    res.json(updated);
  } catch (error: unknown) {
    sendServerError(res, error, "TournamentRouter.stopCheckin");
  }
});
