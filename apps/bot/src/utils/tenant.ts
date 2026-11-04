import { Request } from "express";
import { supabase } from "../lib/supabase";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedOrganization {
  id: string;
  slug: string;
  name: string;
  language: "fr" | "en";
  discordGuildId: string | null;
  discordEnabled: boolean;
  discordConfig: Record<string, unknown>;
}

/**
 * Résout une organisation par son `id` UUID, son `slug` ou le `guild_id` Discord de son intégration.
 * Renvoie `null` si aucune ligne `organizations` ne correspond (ex: fixture de test purement `server_settings`).
 */
export async function resolveOrganization(identifier: string): Promise<ResolvedOrganization | null> {
  if (!identifier) return null;

  let orgRow: Record<string, unknown> | null = null;

  if (UUID_REGEX.test(identifier)) {
    const { data } = await supabase.from("organizations").select("*").eq("id", identifier).maybeSingle();
    const candidate = data as Record<string, unknown> | null;
    if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
      orgRow = candidate;
    }
  }

  if (!orgRow) {
    const { data } = await supabase.from("organizations").select("*").eq("slug", identifier).maybeSingle();
    const candidate = data as Record<string, unknown> | null;
    if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
      orgRow = candidate;
    }
  }

  if (!orgRow) {
    const { data: intData } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("provider", "DISCORD")
      .eq("external_id", identifier)
      .maybeSingle();
    const intRow = intData as Record<string, unknown> | null;
    if (intRow && typeof intRow.organization_id === "string") {
      const { data } = await supabase.from("organizations").select("*").eq("id", intRow.organization_id).maybeSingle();
      const candidate = data as Record<string, unknown> | null;
      if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
        orgRow = candidate;
      }
    }
  }

  if (!orgRow || typeof orgRow.id !== "string" || typeof orgRow.slug !== "string") {
    return null;
  }

  const { data: discordInt } = await supabase
    .from("organization_integrations")
    .select("*")
    .eq("organization_id", orgRow.id)
    .eq("provider", "DISCORD")
    .maybeSingle();

  const intRecord = discordInt as Record<string, unknown> | null;
  const hasDiscordInt = intRecord && typeof intRecord.organization_id === "string";

  return {
    id: orgRow.id,
    slug: orgRow.slug,
    name: typeof orgRow.name === "string" ? orgRow.name : orgRow.slug,
    language: orgRow.language === "en" ? "en" : "fr",
    discordGuildId: hasDiscordInt && typeof intRecord.external_id === "string" ? intRecord.external_id : null,
    discordEnabled: hasDiscordInt ? Boolean(intRecord.enabled) : false,
    discordConfig:
      hasDiscordInt && typeof intRecord.config === "object" && intRecord.config !== null
        ? (intRecord.config as Record<string, unknown>)
        : {},
  };
}

/**
 * Serveur / organisation authentifié par requireGuildAdmin, utilisé par toutes les routes avant leurs vérifications.
 * SEC-21 (fermé par défaut) : pour un TO de tournoi, il n'existe qu'une fois sa portée vérifiée par
 * requireTournamentScope. Une route qui oublie cette garde répond donc 403 au lieu de s'ouvrir à ce niveau.
 */
export function getAuthenticatedGuildId(req: Request): string | null {
  const check = req.adminCheck;
  if (!check) return null;
  if (check.access.level === "SERVER" || check.access.level === "ORGANIZATION" || req.tournamentScope) {
    return check.guildId;
  }
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

async function matchesTenant(
  row: { guild_id?: string | null; organization_id?: string | null } | null | undefined,
  expectedTenantId: string,
): Promise<boolean> {
  if (!row) return false;
  if (row.guild_id === expectedTenantId || row.organization_id === expectedTenantId) {
    return true;
  }
  const org = await resolveOrganization(expectedTenantId);
  if (!org) return false;
  return row.organization_id === org.id || (org.discordGuildId !== null && row.guild_id === org.discordGuildId);
}

/**
 * Verify that a tournament belongs to the authenticated organization or guild.
 * Returns true if valid, false if invalid or not found.
 */
export async function verifyTournamentGuild(tournamentId: string, expectedGuildId: string): Promise<boolean> {
  if (!tournamentId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("tournaments")
    .select("guild_id, organization_id")
    .eq("id", tournamentId)
    .maybeSingle();

  if (error || !data) return false;
  return matchesTenant(data as { guild_id?: string | null; organization_id?: string | null }, expectedGuildId);
}

export const verifyTournamentOrganization = verifyTournamentGuild;

/**
 * Verify that a phase belongs to the authenticated organization or guild.
 */
export async function verifyPhaseGuild(phaseId: string, expectedGuildId: string): Promise<boolean> {
  if (!phaseId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("phases")
    .select("tournament_id, tournaments!inner(guild_id, organization_id)")
    .eq("id", phaseId)
    .maybeSingle();

  if (error || !data) return false;
  const anyData = data as Record<string, unknown>;
  const tourney = anyData.tournaments as
    | { guild_id?: string | null; organization_id?: string | null }
    | { guild_id?: string | null; organization_id?: string | null }[]
    | undefined;
  const extracted = Array.isArray(tourney) ? tourney[0] : tourney;
  if (extracted && (extracted.guild_id || extracted.organization_id)) {
    return matchesTenant(extracted, expectedGuildId);
  }
  if (typeof anyData.tournament_id === "string") {
    return verifyTournamentGuild(anyData.tournament_id, expectedGuildId);
  }
  return false;
}

/**
 * Verify that a team belongs to the authenticated organization or guild.
 */
export async function verifyTeamGuild(teamId: string, expectedGuildId: string): Promise<boolean> {
  if (!teamId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("teams")
    .select("tournament_id, tournaments!inner(guild_id, organization_id)")
    .eq("id", teamId)
    .maybeSingle();

  if (error || !data) return false;
  const anyData = data as Record<string, unknown>;
  const tourney = anyData.tournaments as
    | { guild_id?: string | null; organization_id?: string | null }
    | { guild_id?: string | null; organization_id?: string | null }[]
    | undefined;
  const extracted = Array.isArray(tourney) ? tourney[0] : tourney;
  if (extracted && (extracted.guild_id || extracted.organization_id)) {
    return matchesTenant(extracted, expectedGuildId);
  }
  if (typeof anyData.tournament_id === "string") {
    return verifyTournamentGuild(anyData.tournament_id, expectedGuildId);
  }
  return false;
}

/**
 * Verify that a match belongs to the authenticated organization or guild.
 */
export async function verifyMatchGuild(matchId: string, expectedGuildId: string): Promise<boolean> {
  if (!matchId || !expectedGuildId) return false;
  const { data, error } = await supabase
    .from("matches")
    .select("phase_id, phases!inner(tournaments!inner(guild_id, organization_id))")
    .eq("id", matchId)
    .maybeSingle();

  if (error || !data) return false;
  const anyData = data as Record<string, unknown>;
  const phase = anyData.phases as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const phaseObj = Array.isArray(phase) ? phase[0] : phase;
  const tourney = phaseObj?.tournaments as
    | { guild_id?: string | null; organization_id?: string | null }
    | { guild_id?: string | null; organization_id?: string | null }[]
    | undefined;
  const extracted = Array.isArray(tourney) ? tourney[0] : tourney;
  if (extracted && (extracted.guild_id || extracted.organization_id)) {
    return matchesTenant(extracted, expectedGuildId);
  }
  if (typeof anyData.phase_id === "string") {
    return verifyPhaseGuild(anyData.phase_id, expectedGuildId);
  }
  return false;
}
