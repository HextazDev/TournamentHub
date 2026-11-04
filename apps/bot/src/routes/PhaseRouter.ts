import { Router } from "express";
import { GroupPointsSettingsSchema, PhaseSeedingSchema, isMatchStarted } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { BracketGeneratorService } from "../services/BracketGeneratorService";
import { RoundRobinGeneratorService } from "../services/RoundRobinGeneratorService";
import { LifecycleService } from "../services/LifecycleService";
import { getAuthenticatedGuildId, verifyPhaseGuild, verifyTournamentGuild } from "../utils/tenant";
import { DomainError, sendServerError } from "../utils/serverError";

export const phaseRouter = Router();

// Créer une phase
phaseRouter.post("/", async (req, res) => {
  try {
    const { tournament_id, name, format, phase_order, bracket_size, settings } = req.body;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournament_id, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { data: newPhase, error } = await supabase
      .from("phases")
      .insert({
        tournament_id,
        name,
        format: format || "SINGLE_ELIM",
        bracket_size: bracket_size || 8,
        phase_order: phase_order || 1,
        settings: settings || {}
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(newPhase);
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.create");
  }
});

// Obtenir les phases d'un tournoi
phaseRouter.get("/:tournamentId", async (req, res) => {
  try {
    const tournamentId = req.params.tournamentId;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournamentId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    const { data: phases, error } = await supabase
      .from("phases")
      .select("*")
      .eq("tournament_id", tournamentId)
      .order("phase_order", { ascending: true });

    if (error) throw error;
    res.json(phases || []);
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.list");
  }
});

// Appliquer le seeding et régénérer l'arbre (Live Edit) — transactionnel via RPC
phaseRouter.put("/:id/seeding", async (req, res) => {
  try {
    const phaseId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyPhaseGuild(phaseId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette phase n'appartient pas à votre serveur." });
    }

    // PH-02 : le corps est une entrée externe, validé avant toute lecture ou suppression.
    const parsed = PhaseSeedingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }
    const { participants } = parsed.data;

    // SCR-09 : le re-seed supprime les matchs de la phase ; refusé dès qu'un match réel a commencé (même à 0-0).
    const { data: phaseMatches, error: matchCheckErr } = await supabase
      .from('matches')
      .select('id, status, team1_score, team2_score, team1_id, team2_id')
      .eq('phase_id', phaseId);

    if (matchCheckErr) throw matchCheckErr;
    if (phaseMatches.some(isMatchStarted)) {
      return res.status(400).json({ error: 'Impossible de modifier le placement : des matchs ont déjà des scores ou sont terminés.' });
    }

    // Use atomic RPC to delete phase_teams + matches, then insert new seeding
    if (participants.length > 0) {
      // SEC-20 : seules les équipes du tournoi de la phase peuvent y être placées (jamais celles d'un autre tournoi/serveur).
      const { data: phase, error: phaseLookupErr } = await supabase
        .from('phases')
        .select('tournament_id')
        .eq('id', phaseId)
        .single();
      if (phaseLookupErr) throw phaseLookupErr;
      const teamIds = participants.map((p) => p.team_id);
      const { data: ownTeams, error: teamsErr } = await supabase
        .from('teams')
        .select('id')
        .in('id', teamIds)
        .eq('tournament_id', phase.tournament_id);
      if (teamsErr) throw teamsErr;
      if (ownTeams.length !== teamIds.length) {
        throw new DomainError(400, "Le placement contient une équipe qui n'est pas inscrite à ce tournoi.");
      }

      const { error: rpcError } = await supabase.rpc('regenerate_phase_seeding', {
        p_phase_id: phaseId,
        p_participants: participants
      });
      if (rpcError) throw rpcError;
    } else {
      const { error: delMatches } = await supabase.from('matches').delete().eq('phase_id', phaseId);
      if (delMatches) throw delMatches;
      const { error: delTeams } = await supabase.from('phase_teams').delete().eq('phase_id', phaseId);
      if (delTeams) throw delTeams;
    }

    // Generate bracket or round-robin matches
    const { data: phaseData, error: phaseErr } = await supabase.from('phases').select('bracket_size, format, max_groups').eq('id', phaseId).single();
    if (phaseErr) throw phaseErr;

    if (phaseData.format === "ROUND_ROBIN") {
      await RoundRobinGeneratorService.generateGroups(phaseId, phaseData.max_groups || 1);
    } else if (phaseData.format === "SWISS") {
      const { SwissGeneratorService } = require("../services/SwissGeneratorService");
      await SwissGeneratorService.generateFirstRound(phaseId);
    } else {
      await BracketGeneratorService.generateBracket(phaseId, phaseData.bracket_size || 8);
    }

    // Sync Discord channels if tournament is active
    const { data: phaseWithTourney } = await supabase.from("phases").select("tournaments!inner(guild_id, status)").eq("id", phaseId).single();
    const tourneyInfo: any = phaseWithTourney?.tournaments;
    const tourneyStatus = Array.isArray(tourneyInfo) ? tourneyInfo[0]?.status : tourneyInfo?.status;
    const tourneyGuild = Array.isArray(tourneyInfo) ? tourneyInfo[0]?.guild_id : tourneyInfo?.guild_id;

    if (tourneyStatus === "ACTIVE") {
      const discordClient = req.app.locals.discordClient;
      await LifecycleService.syncPhaseChannels(phaseId, tourneyGuild, discordClient).catch(e => console.error("Auto Sync Failed", e));
    }
    res.status(200).json({ message: 'Placement et arbre mis à jour avec succès' });
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.updateSeeding");
  }
});

// Récupérer le seeding actuel
phaseRouter.get("/:id/seeding", async (req, res) => {
  try {
    const phaseId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyPhaseGuild(phaseId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette phase n'appartient pas à votre serveur." });
    }

    const { data: seeded, error: err1 } = await supabase.from('phase_teams').select('team_id, seed, teams(id, name, logo_url)').eq('phase_id', phaseId).order('seed', { ascending: true });
    if (err1) throw err1;
    res.status(200).json(seeded || []);
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.getSeeding");
  }
});

// DELETE /api/phases/:id — Delete a phase and its matches
phaseRouter.delete("/:id", async (req, res) => {
  try {
    const phaseId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyPhaseGuild(phaseId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette phase n'appartient pas à votre serveur." });
    }

    const { error: matchErr } = await supabase.from("matches").delete().eq("phase_id", phaseId);
    if (matchErr) throw matchErr;

    const { error: ptErr } = await supabase.from("phase_teams").delete().eq("phase_id", phaseId);
    if (ptErr) throw ptErr;

    const { error } = await supabase.from("phases").delete().eq("id", phaseId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.delete");
  }
});

// PUT /api/phases/:id — Update phase config (name, order, bracket_size, max_groups, settings)
phaseRouter.put("/:id", async (req, res) => {
  try {
    const phaseId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyPhaseGuild(phaseId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette phase n'appartient pas à votre serveur." });
    }

    const { name, phase_order, bracket_size, max_groups, settings } = req.body;

    const updatePayload: any = {};
    if (name !== undefined) updatePayload.name = name;
    if (phase_order !== undefined) updatePayload.phase_order = phase_order;
    if (bracket_size !== undefined) updatePayload.bracket_size = bracket_size;
    if (max_groups !== undefined) updatePayload.max_groups = max_groups;
    if (settings !== undefined) {
      const parsedSettings = GroupPointsSettingsSchema.safeParse(settings);
      if (!parsedSettings.success) {
        return res.status(400).json({
          error: "Validation Error",
          details: parsedSettings.error.issues.map((e) => ({
            field: ["settings", ...e.path].join("."),
            message: e.message,
          })),
        });
      }
      updatePayload.settings = parsedSettings.data;
    }

    const { data, error } = await supabase
      .from("phases")
      .update(updatePayload)
      .eq("id", phaseId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.update");
  }
});

// Synchroniser les salons Discord
phaseRouter.post("/:id/sync", async (req, res) => {
  try {
    const phaseId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyPhaseGuild(phaseId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette phase n'appartient pas à votre serveur." });
    }

    const { guildId } = req.body;
    const discordClient = req.app.locals.discordClient;

    if (!guildId) return res.status(400).json({ error: "Missing guildId" });

    await LifecycleService.syncPhaseChannels(phaseId, guildId, discordClient);
    res.status(200).json({ message: 'Salons Discord générés avec succès' });
  } catch (error: unknown) {
    sendServerError(res, error, "PhaseRouter.sync");
  }
});
