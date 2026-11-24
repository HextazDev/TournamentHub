import { AsyncLocalStorage } from "node:async_hooks";
import { Request } from "express";
import { supabase } from "../lib/supabase";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedOrganization {
  id: string;
  slug: string;
  name: string;
  language: "fr" | "en";
  invite_url?: string | null;
  discordGuildId: string | null;
  discordEnabled: boolean;
  discordConfig: Record<string, unknown>;
}

const requestTenantCache = new AsyncLocalStorage<Map<string, ResolvedOrganization>>();

/**
 * PERF-01 : ouvre un cache de résolution d'organisation borné à la requête HTTP courante
 * (monté sur `/api` dans `index.ts`). Aucun état partagé entre requêtes : zéro staleness inter-requêtes.
 */
export function runWithRequestTenantCache<T>(fn: () => T): T {
  return requestTenantCache.run(new Map(), fn);
}

/**
 * PERF-01 / DISC-17 : sort du cache de requête HTTP courant pour les tâches différées en arrière-plan
 * (un `setTimeout` lancé depuis une route `/api` hériterait sinon de la `Map` de cette requête et relirait
 * un état d'organisation périmé).
 */
export function runWithoutRequestTenantCache<T>(fn: () => T): T {
  return requestTenantCache.exit(fn);
}

/** PERF-01 : purge du cache de la requête courante après une mutation d'organisation ou d'intégration. */
export function clearOrganizationCache(): void {
  requestTenantCache.getStore()?.clear();
}

/**
 * Résout une organisation par son `id` UUID, son `slug` ou le `guild_id` Discord de son intégration.
 * Renvoie `null` si aucune ligne `organizations` ne correspond.
 * PERF-01 : à l'intérieur d'une requête HTTP, les résolutions réussies sont mémoïsées pour amortir
 * les chaînes `verify*Organization` (une même requête API peut sinon déclencher 8-10 lectures Supabase de
 * résolution de tenant). Les échecs (`null`) ne sont jamais mémoïsés : la base est relue à chaque tentative.
 * Hors requête HTTP (planificateur, scripts, tests), la base est toujours relue.
 */
export async function resolveOrganization(identifier: string): Promise<ResolvedOrganization | null> {
  if (!identifier) return null;
  const memo = requestTenantCache.getStore();
  if (memo?.has(identifier)) return memo.get(identifier) ?? null;

  const org = await resolveOrganizationUncached(identifier);
  if (org && memo) {
    memo.set(identifier, org);
    memo.set(org.id, org);
    memo.set(org.slug, org);
    if (org.discordGuildId) memo.set(org.discordGuildId, org);
  }
  return org;
}

async function resolveOrganizationUncached(identifier: string): Promise<ResolvedOrganization | null> {

  let orgRow: Record<string, unknown> | null = null;

  if (UUID_REGEX.test(identifier)) {
    const { data, error } = await supabase.from("organizations").select("*").eq("id", identifier).maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    const candidate = data as Record<string, unknown> | null;
    if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
      orgRow = candidate;
    }
  }

  // SEC-01 : résoudre l'external_id Discord AVANT le slug pour empêcher le squat de snowflakes
  if (!orgRow) {
    const { data: intData, error: intError } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("provider", "DISCORD")
      .eq("external_id", identifier)
      .maybeSingle();
    if (intError && intError.code !== "PGRST116") throw intError;
    const intRow = intData as Record<string, unknown> | null;
    if (intRow && typeof intRow.organization_id === "string") {
      const { data, error } = await supabase.from("organizations").select("*").eq("id", intRow.organization_id).maybeSingle();
      if (error && error.code !== "PGRST116") throw error;
      const candidate = data as Record<string, unknown> | null;
      if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
        orgRow = candidate;
      }
    }
  }

  // Slug en dernier
  if (!orgRow) {
    const { data, error } = await supabase.from("organizations").select("*").eq("slug", identifier).maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    const candidate = data as Record<string, unknown> | null;
    if (candidate && typeof candidate.id === "string" && typeof candidate.slug === "string") {
      orgRow = candidate;
    }
  }

  if (!orgRow || typeof orgRow.id !== "string" || typeof orgRow.slug !== "string") {
    return null;
  }

  const { data: discordInt, error: discordIntError } = await supabase
    .from("organization_integrations")
    .select("*")
    .eq("organization_id", orgRow.id)
    .eq("provider", "DISCORD")
    .maybeSingle();
  // CLN-07 : une erreur DB transitoire ne doit jamais être masquée en `discordEnabled: false` puis mise en cache.
  if (discordIntError && discordIntError.code !== "PGRST116") throw discordIntError;

  const intRecord = discordInt as Record<string, unknown> | null;
  const hasDiscordInt = intRecord && typeof intRecord.organization_id === "string";

  return {
    id: orgRow.id,
    slug: orgRow.slug,
    name: typeof orgRow.name === "string" ? orgRow.name : orgRow.slug,
    language: orgRow.language === "en" ? "en" : "fr",
    invite_url:
      typeof orgRow.invite_url === "string"
        ? orgRow.invite_url
        : typeof orgRow.public_contact_url === "string"
          ? orgRow.public_contact_url
          : null,
    discordGuildId: hasDiscordInt && typeof intRecord.external_id === "string" ? intRecord.external_id : null,
    // LIFE-02 : sans serveur lié, une intégration « active » n'a aucun effet Discord possible.
    discordEnabled: hasDiscordInt ? Boolean(intRecord.enabled) && typeof intRecord.external_id === "string" : false,
    discordConfig:
      hasDiscordInt && typeof intRecord.config === "object" && intRecord.config !== null
        ? (intRecord.config as Record<string, unknown>)
        : {},
  };
}

/**
 * Serveur Discord à solliciter pour une organisation, ou `null` si l'intégration est coupée ou non liée (SEC-26) :
 * point de passage de tout effet Discord hors du bus (planificateur, progression des matchs).
 */
export async function resolveActiveDiscordGuild(organizationId: string | null | undefined): Promise<string | null> {
  if (!organizationId) return null;
  const org = await resolveOrganization(organizationId);
  return org?.discordEnabled ? org.discordGuildId : null;
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

interface TournamentTenantRow {
  organization_id?: string | null;
}

interface JoinedTournamentChildRow {
  tournament_id?: string | null;
  tournaments?: TournamentTenantRow | TournamentTenantRow[] | null;
}

interface JoinedMatchRow {
  phase_id?: string | null;
  phases?: { tournaments?: TournamentTenantRow | TournamentTenantRow[] | null } | { tournaments?: TournamentTenantRow | TournamentTenantRow[] | null }[] | null;
}

function unwrapSingle<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

async function matchesTenant(
  row: TournamentTenantRow | null | undefined,
  expectedTenantId: string,
): Promise<boolean> {
  if (!row?.organization_id) return false;
  const org = await resolveOrganization(expectedTenantId);
  if (!org) return false;
  return row.organization_id === org.id;
}

async function verifyTournamentChildOrganization(
  table: "phases" | "teams",
  id: string,
  expectedTenantId: string,
): Promise<boolean> {
  if (!id || !expectedTenantId) return false;
  const { data, error } = await supabase
    .from(table)
    .select("tournament_id, tournaments!inner(organization_id)")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return false;
  const row = data as JoinedTournamentChildRow;
  const tourney = unwrapSingle(row.tournaments);
  if (tourney?.organization_id) {
    return matchesTenant(tourney, expectedTenantId);
  }
  if (typeof row.tournament_id === "string") {
    return verifyTournamentOrganization(row.tournament_id, expectedTenantId);
  }
  return false;
}

/**
 * Verify that a tournament belongs to the authenticated organization.
 * Returns true if valid, false if invalid or not found.
 */
export async function verifyTournamentOrganization(tournamentId: string, expectedTenantId: string): Promise<boolean> {
  if (!tournamentId || !expectedTenantId) return false;
  const { data, error } = await supabase
    .from("tournaments")
    .select("organization_id")
    .eq("id", tournamentId)
    .maybeSingle();

  if (error || !data) return false;
  return matchesTenant(data as TournamentTenantRow, expectedTenantId);
}

/**
 * Verify that a phase belongs to the authenticated organization.
 */
export async function verifyPhaseOrganization(phaseId: string, expectedTenantId: string): Promise<boolean> {
  return verifyTournamentChildOrganization("phases", phaseId, expectedTenantId);
}

/**
 * Verify that a team belongs to the authenticated organization.
 */
export async function verifyTeamOrganization(teamId: string, expectedTenantId: string): Promise<boolean> {
  return verifyTournamentChildOrganization("teams", teamId, expectedTenantId);
}

/**
 * Verify that a match belongs to the authenticated organization.
 */
export async function verifyMatchOrganization(matchId: string, expectedTenantId: string): Promise<boolean> {
  if (!matchId || !expectedTenantId) return false;
  const { data, error } = await supabase
    .from("matches")
    .select("phase_id, phases!inner(tournaments!inner(organization_id))")
    .eq("id", matchId)
    .maybeSingle();

  if (error || !data) return false;
  const row = data as JoinedMatchRow;
  const phase = unwrapSingle(row.phases);
  const tourney = unwrapSingle(phase?.tournaments);
  if (tourney?.organization_id) {
    return matchesTenant(tourney, expectedTenantId);
  }
  if (typeof row.phase_id === "string") {
    return verifyPhaseOrganization(row.phase_id, expectedTenantId);
  }
  return false;
}
