import { Router } from "express";
import { supabase } from "../lib/supabase";
import { RegistrationService } from "../services/RegistrationService";
import { LifecycleService } from "../services/LifecycleService";
import { ArchiveService } from "../services/ArchiveService";
import { SchedulerService } from "../services/SchedulerService";
import { getAuthenticatedGuildId, verifyTournamentGuild } from "../utils/tenant";
import { LocaleSchema } from "@hub/shared";
import { logger } from "../utils/logger";

const OptionalLocaleSchema = LocaleSchema.optional();

export const tournamentRouter = Router();

// POST /api/tournaments — Create a new tournament (defaults to DRAFT)
tournamentRouter.post("/", async (req, res) => {
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

    res.status(201).json(created);
  } catch (error: any) {
    console.error("[TournamentRouter] Create error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/tournaments/:id/settings — Update tournament settings
tournamentRouter.put("/:id/settings", async (req, res) => {
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

    let transitionToRegistration = false;
    let newStatus = currentTournament.status;

    // Transition automatically from DRAFT to REGISTRATION if valid checkin dates are provided
    if (currentTournament.status === "DRAFT" && checkin_start_at && checkin_end_at) {
      newStatus = "REGISTRATION";
      transitionToRegistration = true;
    }

    const payload: any = {
      status: newStatus,
      start_at: start_at || null,
      checkin_start_at: checkin_start_at || null,
      checkin_end_at: checkin_end_at || null,
      discord_registration_channel_id: discord_registration_channel_id || null,
      discord_announcement_channel_id: discord_announcement_channel_id || null,
      discord_checkin_channel_id: discord_checkin_channel_id || null,
      discord_captain_role_id: discord_captain_role_id || null,
      discord_to_role_id: discord_to_role_id || null,
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

    res.json(data);
  } catch (error: any) {
    console.error("[TournamentRouter] Settings update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/tournaments/:id/visibility — Toggle is_public
tournamentRouter.patch("/:id/visibility", async (req, res) => {
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
  } catch (error: any) {
    console.error("[TournamentRouter] Visibility update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// /api/tournaments/:id/launch
tournamentRouter.post("/:id/launch", async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { guildId } = req.body;
    const discordClient = req.app.locals.discordClient;

    const targetGuildId = guildId || authGuildId;
    await LifecycleService.launchTournament(tournamentId, targetGuildId, discordClient);
    res.json({ success: true, message: "Tournament launched successfully." });
  } catch (error: any) {
    console.error(`[TournamentRouter] Error launching tournament:`, error);
    res.status(500).json({ error: error.message });
  }
});

// /api/tournaments/:id/close
tournamentRouter.post("/:id/close", async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { guildId } = req.body;
    const discordClient = req.app.locals.discordClient;

    const targetGuildId = guildId || authGuildId;
    await LifecycleService.closeTournament(tournamentId, targetGuildId, discordClient);
    res.json({ success: true, message: "Tournament closed successfully." });
  } catch (error: any) {
    console.error(`[TournamentRouter] Error closing tournament:`, error);
    res.status(500).json({ error: error.message });
  }
});

// /api/tournaments/:id/registrations
tournamentRouter.post("/:id/registrations", async (req, res) => {
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
      logger.error(`[TournamentRouter] Annonce d'inscription échouée pour ${tournamentId}:`, embedError);
      return res.status(502).json({ error: embedError instanceof Error ? embedError.message : "Discord announcement failed" });
    }

    const { error: flagError } = await supabase
      .from('tournaments')
      .update({ is_registration_open: true })
      .eq('id', tournamentId);
    if (flagError) {
      logger.error(`[TournamentRouter] Ouverture des inscriptions non enregistrée pour ${tournamentId}:`, flagError);
      return res.status(500).json({ error: flagError.message });
    }

    res.json({ success: true, message: "Registration action executed." });
  } catch (error: any) {
    console.error(`[TournamentRouter] Error:`, error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tournaments/:id/checkin/stop — Stop check-in immediately (Kill Switch)
tournamentRouter.post("/:id/checkin/stop", async (req, res) => {
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
  } catch (error: any) {
    console.error("[TournamentRouter] Stop check-in error:", error);
    res.status(500).json({ error: error.message });
  }
});
