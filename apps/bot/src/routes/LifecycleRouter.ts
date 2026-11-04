import type { Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { getAuthenticatedGuildId, getTournamentScope, verifyTournamentGuild } from "../utils/tenant";
import { invalidateGuildAccess } from "../services/MemberAccessService";
import { SchedulerService } from "../services/SchedulerService";
import { ArchiveService } from "../services/ArchiveService";
import { logger } from "../utils/logger";

/** Monté derrière requireTournamentScope(tournamentFrom.body("tournament_id")) : le tournoi vient de la garde (SEC-21). */
export async function syncSchedule(req: Request, res: Response) {
  const tournamentId = getTournamentScope(req);
  const guildId = getAuthenticatedGuildId(req);
  if (!tournamentId) return res.status(400).json({ error: "tournament_id required" });
  if (!guildId || !await verifyTournamentGuild(tournamentId, guildId)) return res.status(403).json({ error: "Access denied" });
  try {
    const { data: tournament, error } = await supabase.from("tournaments").select("*")
      .eq("id", tournamentId).eq("guild_id", guildId).single();
    if (error || !tournament) return res.status(404).json({ error: "Tournament not found" });
    SchedulerService.scheduleTournament(tournament);
    return res.status(200).json({ message: "Schedule synchronisé avec succès." });
  } catch (error) {
    logger.error("Schedule sync failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function archiveAndInit(req: Request, res: Response) {
  const tournamentId: unknown = req.body?.newTournamentId;
  const guildId = getAuthenticatedGuildId(req);
  if (typeof tournamentId !== "string" || !tournamentId || !guildId || req.body?.guildId !== guildId) {
    return res.status(400).json({ error: "guildId and newTournamentId required" });
  }
  if (!await verifyTournamentGuild(tournamentId, guildId)) return res.status(403).json({ error: "Access denied" });
  try {
    const { data: tournament, error: fetchError } = await supabase.from("tournaments").select("*")
      .eq("id", tournamentId).eq("guild_id", guildId).single();
    if (fetchError || !tournament) return res.status(404).json({ error: "Tournament not found" });
    const { error: archiveError } = await supabase.from("tournaments").update({ status: "ARCHIVED" })
      .eq("guild_id", guildId).neq("id", tournamentId).neq("status", "ARCHIVED");
    if (archiveError) throw archiveError;
    // SEC-23 / SEC-05 : les rôles TO des tournois archivés ne donnent plus accès, sans attendre le TTL du cache.
    invalidateGuildAccess(guildId);
    const { data: settings, error: settingsError } = await supabase.from("server_settings")
      .select("captain_role_id").eq("guild_id", guildId).single();
    if (settingsError) throw settingsError;
    ArchiveService.backgroundDiscordCleanup(req.app.locals.discordClient, guildId, settings?.captain_role_id)
      .catch((error: unknown) => logger.error("Discord cleanup failed", error));
    SchedulerService.scheduleTournament(tournament);
    return res.status(202).json({ message: "Cleanup and init done", tournament });
  } catch (error) {
    logger.error("Archive and init failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
