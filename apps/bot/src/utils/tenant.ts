import { Request } from "express";
import { supabase } from "../lib/supabase";

/**
 * Extract the authenticated guildId attached by requireGuildAdmin middleware
 */
export function getAuthenticatedGuildId(req: Request): string | null {
  return req.adminCheck?.guildId ?? null;
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
