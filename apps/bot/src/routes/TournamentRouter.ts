import { Router } from "express";
import { supabase } from "../lib/supabase";
import { RegistrationService } from "../services/RegistrationService";
import { LifecycleService } from "../services/LifecycleService";
import { ArchiveService } from "../services/ArchiveService";
import { SchedulerService } from "../services/SchedulerService";
import { getAuthenticatedGuildId, verifyTournamentGuild } from "../utils/tenant";
import { canPerform, LocaleSchema } from "@hub/shared";
import { sendServerError } from "../utils/serverError";
import { requireServerLevel, requireTournamentScope, tournamentFrom } from "../middleware/auth";
import { refreshGuildAccess } from "../services/AccessRefreshService";

const OptionalLocaleSchema = LocaleSchema.optional();

export const tournamentRouter = Router();

// SEC-21 : chaque route déclare sa garde (montage ouvert aux TO de tournoi) ; la création reste au niveau SERVER.
const tournamentScope = requireTournamentScope(tournamentFrom.param("id"));

/** Un champ de rôle est modifié s'il est fourni et diffère de la valeur enregistrée (vide = aucun rôle). */
function roleChanged(requested: unknown, current: string | null): boolean {
  return requested !== undefined && (requested || null) !== current;
}

// POST /api/tournaments — Create a new tournament (defaults to DRAFT)
tournamentRouter.post("/", requireServerLevel, async (req, res) => {
  try {
    const {
      guild_id, name, description, start_at,
      checkin_start_at, checkin_end_at,
      discord_registration_channel_id, discord_announcement_channel_id,
      discord_checkin_channel_id, discord_captain_role_id, discord_to_role_id,
      guildId,
    } = req.body;

    const effectiveGuildId = guild_id || guildId;
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

    // Fetch server default settings
    const { data: serverSettings, error: settingsError } = await supabase
      .from("server_settings")
      .select("*")
      .eq("guild_id", targetGuildId)
      .maybeSingle();
    if (settingsError) throw settingsError;

    const { data: created, error } = await supabase
      .from("tournaments")
      .insert({
        guild_id: targetGuildId,
        name,
        description: description || null,
        game_type: req.body.game_type || "GENERIC",
        status: "DRAFT",
        start_at: start_at || null,
        checkin_start_at: checkin_start_at || null,
        checkin_end_at: checkin_end_at || null,
        discord_registration_channel_id: discord_registration_channel_id || serverSettings?.registration_channel_id || null,
        discord_announcement_channel_id: discord_announcement_channel_id || serverSettings?.announcement_channel_id || null,
        discord_checkin_channel_id: discord_checkin_channel_id || serverSettings?.checkin_channel_id || null,
        discord_captain_role_id: discord_captain_role_id || serverSettings?.captain_role_id || null,
        discord_to_role_id: discord_to_role_id || serverSettings?.to_role_id || null,
        language: requestedLanguage.data ?? serverSettings?.language ?? "fr",
      })
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
      start_at, checkin_start_at, checkin_end_at,
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

    let transitionToRegistration = false;
    let newStatus = currentTournament.status;

    // Transition automatically from DRAFT to REGISTRATION if valid checkin dates are provided
    if (currentTournament.status === "DRAFT" && checkin_start_at && checkin_end_at) {
      newStatus = "REGISTRATION";
      transitionToRegistration = true;
    }

    // SEC-21 : ce passage archive les autres tournois du serveur (et nettoie Discord) : effet réservé au niveau SERVER.
    // L'archivage automatique lui-même (y compris des tournois ACTIVE) est suivi dans #87.
    if (transitionToRegistration && access?.level !== "SERVER") {
      const { count, error: othersError } = await supabase
        .from("tournaments")
        .select("id", { count: "exact", head: true })
        .eq("guild_id", currentTournament.guild_id)
        .neq("id", tournamentId)
        .neq("status", "ARCHIVED");
      if (othersError) throw othersError;
      if ((count ?? 0) > 0) {
        return res.status(403).json({ error: "Archiving other tournaments is reserved to server managers", code: "SERVER_LEVEL_REQUIRED" });
      }
    }

    const payload: any = {
      status: newStatus,
      start_at: start_at || null,
      checkin_start_at: checkin_start_at || null,
      checkin_end_at: checkin_end_at || null,
      discord_registration_channel_id: discord_registration_channel_id || null,
      discord_announcement_channel_id: discord_announcement_channel_id || null,
      discord_checkin_channel_id: discord_checkin_channel_id || null,
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


    // Handle archiving of older tournaments if transitioning from DRAFT to REGISTRATION
    if (transitionToRegistration) {
      try {
        const discordClient = req.app.locals.discordClient;
        const guildId = currentTournament.guild_id;

        await supabase.from("tournaments")
          .update({ status: "ARCHIVED" })
          .eq("guild_id", guildId)
          .neq("id", tournamentId)
          .neq("status", "ARCHIVED");

        const { data: settings } = await supabase.from("server_settings")
          .select("captain_role_id")
          .eq("guild_id", guildId)
          .single();

        ArchiveService.backgroundDiscordCleanup(discordClient, guildId, settings?.captain_role_id).catch((e: any) => console.error(e));
      } catch (archErr: any) {
        console.warn("[TournamentRouter] Archive/cleanup failed on settings transition:", archErr?.message || archErr);
      }
    }

    // Schedule/reschedule check-in tasks if status is REGISTRATION
    if (newStatus === "REGISTRATION" && data.checkin_start_at && data.checkin_end_at) {
      try {
        SchedulerService.scheduleTournament(data);
      } catch (schedErr: any) {
        console.error("[TournamentRouter] Scheduling failed:", schedErr);
      }
    }

    // SEC-05 / DISC-08 : nouveau rôle TO de tournoi, ou autres tournois archivés : cache invalidé tout de suite,
    // annuaire guild_admins resynchronisé en arrière-plan (la réponse n'attend pas le chargement des membres).
    if (data.discord_to_role_id !== currentTournament.discord_to_role_id || transitionToRegistration) {
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
    await LifecycleService.launchTournament(tournamentId, targetGuildId, discordClient);
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
    await LifecycleService.closeTournament(tournamentId, targetGuildId, discordClient);
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
      .select('start_at, start_date, checkin_start_at, status')
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

    try {
      await RegistrationService.sendRegistrationEmbed(tournamentId, discordClient);
    } catch (embedError: unknown) {
      sendServerError(res, embedError, `TournamentRouter.registrations: annonce d'inscription échouée pour ${tournamentId}`, 502);
      return;
    }

    const { error: flagError } = await supabase
      .from('tournaments')
      .update({ is_registration_open: true })
      .eq('id', tournamentId);
    if (flagError) {
      sendServerError(res, flagError, `TournamentRouter.registrations: ouverture des inscriptions non enregistrée pour ${tournamentId}`);
      return;
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
