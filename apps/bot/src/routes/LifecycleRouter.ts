import type { Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { getAuthenticatedGuildId, getTournamentScope, resolveOrganization, verifyTournamentGuild } from "../utils/tenant";
import { refreshGuildAccess } from "../services/AccessRefreshService";
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
    // verifyTournamentGuild a déjà établi l'appartenance à l'organisation authentifiée (LIFE-01).
    const { data: tournament, error } = await supabase.from("tournaments").select("*")
      .eq("id", tournamentId).single();
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
    const org = await resolveOrganization(guildId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const { data: tournament, error: fetchError } = await supabase.from("tournaments").select("*")
      .eq("id", tournamentId).single();
    if (fetchError || !tournament) return res.status(404).json({ error: "Tournament not found" });
    const { data: archived, error: archiveError } = await supabase.from("tournaments").update({ status: "ARCHIVED" })
      .eq("organization_id", org.id).neq("id", tournamentId).neq("status", "ARCHIVED")
      .select("id, discord_captain_role_id, discord_checkin_channel_id");
    if (archiveError) throw archiveError;
    // SEC-23 / SEC-05 / DISC-08 : les rôles TO des tournois archivés ne donnent plus accès ni ne figurent dans le hub.
    refreshGuildAccess(req.app.locals.discordClient, guildId);

    const archivedTournaments = (archived ?? []) as {
      id: string;
      discord_captain_role_id: string | null;
      discord_checkin_channel_id: string | null;
    }[];

    if (archivedTournaments.length > 0 && org.discordEnabled && org.discordGuildId) {
      ArchiveService.backgroundDiscordCleanup(req.app.locals.discordClient, org.discordGuildId, archivedTournaments)
        .catch((error: unknown) => logger.error("Discord cleanup failed", error));
    }
    SchedulerService.scheduleTournament(tournament);
    return res.status(202).json({ message: "Cleanup and init done", tournament });
  } catch (error) {
    logger.error("Archive and init failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
