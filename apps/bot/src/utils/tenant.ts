import { Request } from "express";
import { supabase } from "../lib/supabase";

/**
 * Serveur authentifié par requireGuildAdmin, utilisé par toutes les routes avant leurs vérifications verify*Guild.
 * SEC-21 (fermé par défaut) : pour un TO de tournoi, il n'existe qu'une fois sa portée vérifiée par
 * requireTournamentScope. Une route qui oublie cette garde répond donc 403 au lieu de s'ouvrir à ce niveau.
 */
export function getAuthenticatedGuildId(req: Request): string | null {
  const check = req.adminCheck;
  if (!check) return null;
  if (check.access.level === "SERVER" || req.tournamentScope) return check.guildId;
  return null;
}

/** Tournoi vérifié par requireTournamentScope (URL, corps ou base), seule source autorisée pour les créations. */
export function getTournamentScope(req: Request): string | null {
  return req.tournamentScope?.tournamentId ?? null;
}

export type TournamentResourceKind = "phase" | "match" | "team";

export type TournamentLookup = { ok: true; tournamentId: string | null } | { ok: false };

async function readTournamentId(table: "phases" | "teams", id: string): Promise<TournamentLookup> {
  const { data, error } = await supabase.from(table).select("tournament_id").eq("id", id).maybeSingle();
  if (error) return error.code === "22P02" ? { ok: true, tournamentId: null } : { ok: false };
  const row = data as { tournament_id: string | null } | null;
  return { ok: true, tournamentId: row?.tournament_id ?? null };
}

/**
 * Tournoi propriétaire d'une phase, d'un match ou d'une équipe, lu en base (jamais depuis le corps) — SEC-21.
 * `tournamentId: null` : ressource inconnue ; `ok: false` : lecture impossible.
 */
export async function resolveResourceTournament(kind: TournamentResourceKind, id: string): Promise<TournamentLookup> {
  if (kind === "phase") return readTournamentId("phases", id);
  if (kind === "team") return readTournamentId("teams", id);

  const { data, error } = await supabase.from("matches").select("phase_id").eq("id", id).maybeSingle();
  if (error) return error.code === "22P02" ? { ok: true, tournamentId: null } : { ok: false };
  const match = data as { phase_id: string | null } | null;
  if (!match?.phase_id) return { ok: true, tournamentId: null };
  return readTournamentId("phases", match.phase_id);
}

/**
 * Verify that a tournament belongs to the authenticated guild.
 * Returns true if valid, false if invalid or not found.
 */
export async function verifyTournamentGuild(tournamentId: string, expectedGuildId: string): Promise<boolean> {
  if (!tournamentId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("tournaments")
    .select("guild_id")
    .eq("id", tournamentId)
    .maybeSingle();

  if (error || !data) return false;
  return data.guild_id === expectedGuildId;
}

/**
 * Verify that a phase belongs to the authenticated guild.
 */
export async function verifyPhaseGuild(phaseId: string, expectedGuildId: string): Promise<boolean> {
  if (!phaseId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("phases")
    .select("tournaments!inner(guild_id)")
    .eq("id", phaseId)
    .maybeSingle();

  if (error || !data) return false;
  const tourney: any = data.tournaments;
  const guildId = Array.isArray(tourney) ? tourney[0]?.guild_id : tourney?.guild_id;
  return guildId === expectedGuildId;
}

/**
 * Verify that a team belongs to the authenticated guild.
 */
export async function verifyTeamGuild(teamId: string, expectedGuildId: string): Promise<boolean> {
  if (!teamId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("teams")
    .select("tournaments!inner(guild_id)")
    .eq("id", teamId)
    .maybeSingle();

  if (error || !data) return false;
  const tourney: any = data.tournaments;
  const guildId = Array.isArray(tourney) ? tourney[0]?.guild_id : tourney?.guild_id;
  return guildId === expectedGuildId;
}

/**
 * Verify that a match belongs to the authenticated guild.
 */
export async function verifyMatchGuild(matchId: string, expectedGuildId: string): Promise<boolean> {
  if (!matchId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("matches")
    .select("phases!inner(tournaments!inner(guild_id))")
    .eq("id", matchId)
    .maybeSingle();

  if (error || !data) return false;
  const phase: any = data.phases;
  const tourney: any = Array.isArray(phase) ? phase[0]?.tournaments : phase?.tournaments;
  const guildId = Array.isArray(tourney) ? tourney[0]?.guild_id : tourney?.guild_id;
  return guildId === expectedGuildId;
}
