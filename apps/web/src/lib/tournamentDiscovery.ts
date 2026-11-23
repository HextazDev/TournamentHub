import type { GuildAccess, OrganizationAccess, Tournament } from "@hub/shared";
import { supabaseAdmin } from "./supabase-admin";

type AdminAccessResult =
  | { allowed: true; access: GuildAccess | OrganizationAccess }
  | { allowed: false; reason: string };

function mergeTournamentsByDate(...lists: readonly (readonly Tournament[])[]): Tournament[] {
  const byId = new Map<string, Tournament>();
  for (const list of lists) {
    for (const tournament of list) {
      if (!byId.has(tournament.id)) byId.set(tournament.id, tournament);
    }
  }
  return [...byId.values()].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/**
 * Charge les tournois publics et privés visibles sur `/tournaments` (SEC-10, SEC-21, SEC-23, SEC-40).
 * - Les membres d'organisation (`organization_members`) et membres Discord actifs voient les tournois privés de leur organisation.
 * - Un `tournament_staff` n'accède QU'aux tournois non archivés qui lui sont explicitement assignés, jamais à toute l'organisation.
 */
export async function loadDiscoverableTournaments(
  discordId: string | null,
  guildIds: readonly string[],
): Promise<{ publicList: Tournament[]; privateList: Tournament[] }> {
  const [publicRes, discordIntsRes, membersRes, staffRes] = await Promise.all([
    supabaseAdmin
      .from("tournaments")
      .select("*")
      .eq("is_public", true)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false })
      .limit(60),
    guildIds.length > 0
      ? supabaseAdmin
          .from("organization_integrations")
          .select("organization_id")
          .eq("provider", "DISCORD")
          .eq("enabled", true)
          .in("external_id", [...guildIds])
      : Promise.resolve({ data: [], error: null }),
    discordId
      ? supabaseAdmin.from("organization_members").select("organization_id").eq("user_id", discordId)
      : Promise.resolve({ data: [], error: null }),
    discordId
      ? supabaseAdmin
          .from("tournament_staff")
          .select("tournament_id, tournaments!inner(status)")
          .eq("user_id", discordId)
          .neq("tournaments.status", "ARCHIVED")
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (publicRes.error) throw new Error(`public tournaments read failed: ${publicRes.error.message}`);
  if (discordIntsRes.error) throw new Error(`discord integrations read failed: ${discordIntsRes.error.message}`);
  if (membersRes.error) throw new Error(`organization_members read failed: ${membersRes.error.message}`);
  if (staffRes.error) throw new Error(`tournament_staff read failed: ${staffRes.error.message}`);

  const accessibleOrgIds = new Set<string>();
  for (const row of (discordIntsRes.data ?? []) as { organization_id?: string }[]) {
    if (row.organization_id) accessibleOrgIds.add(row.organization_id);
  }
  for (const row of (membersRes.data ?? []) as { organization_id?: string }[]) {
    if (row.organization_id) accessibleOrgIds.add(row.organization_id);
  }

  const staffTournamentIds = new Set<string>();
  for (const row of (staffRes.data ?? []) as { tournament_id?: string }[]) {
    if (row.tournament_id) staffTournamentIds.add(row.tournament_id);
  }

  // SEC-40 : deux requêtes paramétrées séparées (jamais d'interpolation `.or()`).
  const [orgPrivateRes, staffPrivateRes] = await Promise.all([
    accessibleOrgIds.size > 0
      ? supabaseAdmin
          .from("tournaments")
          .select("*")
          .in("organization_id", [...accessibleOrgIds])
          .eq("is_public", false)
          .neq("status", "ARCHIVED")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    staffTournamentIds.size > 0
      ? supabaseAdmin
          .from("tournaments")
          .select("*")
          .in("id", [...staffTournamentIds])
          .eq("is_public", false)
          .neq("status", "ARCHIVED")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (orgPrivateRes.error) throw new Error(`private tournaments read failed: ${orgPrivateRes.error.message}`);
  if (staffPrivateRes.error) throw new Error(`private staff tournaments read failed: ${staffPrivateRes.error.message}`);

  return {
    publicList: (publicRes.data ?? []) as Tournament[],
    privateList: mergeTournamentsByDate(
      (orgPrivateRes.data ?? []) as Tournament[],
      (staffPrivateRes.data ?? []) as Tournament[],
    ),
  };
}

/**
 * Charge les tournois visibles sur la page publique `/[orgSlug]` (SEC-10, SEC-21, SEC-40).
 * - Un membre de l'organisation (Discord actif, `organization_members` ou accès niveau `SERVER`/`ORGANIZATION`) voit tous les tournois privés.
 * - Un staff de niveau `TOURNAMENT` ne voit que les tournois publics + les tournois privés de sa portée (`access.tournamentIds`).
 */
export async function loadOrganizationHubTournaments(params: {
  organizationId: string;
  viewerDiscordId: string | null;
  isActiveDiscordMember: boolean;
  access: AdminAccessResult;
}): Promise<{ tournaments: Tournament[]; isMember: boolean }> {
  const { organizationId, viewerDiscordId, isActiveDiscordMember, access } = params;
  const hasOrgLevelAccess =
    access.allowed && (access.access.level === "SERVER" || access.access.level === "ORGANIZATION");

  let isNativeOrgMember = false;
  if (!isActiveDiscordMember && !hasOrgLevelAccess && viewerDiscordId) {
    const { data, error } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", viewerDiscordId)
      .maybeSingle();
    if (error) throw new Error(`organization_members read failed: ${error.message}`);
    isNativeOrgMember = Boolean(data);
  }

  const isOrgMember = isActiveDiscordMember || hasOrgLevelAccess || isNativeOrgMember;
  if (isOrgMember) {
    const { data, error } = await supabaseAdmin
      .from("tournaments")
      .select("*")
      .eq("organization_id", organizationId)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`tournaments read failed: ${error.message}`);
    return { tournaments: (data ?? []) as Tournament[], isMember: true };
  }

  const scopedTournamentIds =
    access.allowed && access.access.level === "TOURNAMENT" ? access.access.tournamentIds : [];

  const [publicRes, scopedPrivateRes] = await Promise.all([
    supabaseAdmin
      .from("tournaments")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("is_public", true)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false }),
    scopedTournamentIds.length > 0
      ? supabaseAdmin
          .from("tournaments")
          .select("*")
          .eq("organization_id", organizationId)
          .in("id", [...scopedTournamentIds])
          .eq("is_public", false)
          .neq("status", "ARCHIVED")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (publicRes.error) throw new Error(`tournaments read failed: ${publicRes.error.message}`);
  if (scopedPrivateRes.error) throw new Error(`scoped private tournaments read failed: ${scopedPrivateRes.error.message}`);

  return {
    tournaments: mergeTournamentsByDate(
      (publicRes.data ?? []) as Tournament[],
      (scopedPrivateRes.data ?? []) as Tournament[],
    ),
    isMember: false,
  };
}
