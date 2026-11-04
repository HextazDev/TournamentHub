import { PermissionFlagsBits } from "discord.js";
import type {
  AccessDeniedCode,
  GuildAccess,
  GuildAdminReason,
  OrganizationRole,
  TournamentStaffRole,
} from "@hub/shared";
import { supabase } from "../lib/supabase";
import { resolveAdminReason } from "../utils/adminAccess";
import { resolveOrganization, type ResolvedOrganization } from "../utils/tenant";
import { readToRoleId, readTournamentToRoles } from "./GuildRegistryService";

/** Sous-ensemble du client Discord utilisé (facilite les tests). */
export interface DiscordClientLike {
  guilds: {
    fetch(guildId: string): Promise<{
      ownerId: string;
      members: {
        fetch(userId: string): Promise<{
          permissions: { has(flag: bigint): boolean };
          roles: { cache: { has(roleId: string): boolean } };
        }>;
      };
    }>;
  };
}

export type MemberAccessDecision =
  | { allowed: true; access: GuildAccess }
  | { allowed: false; code: Extract<AccessDeniedCode, "NOT_A_MEMBER" | "NO_RIGHTS" | "BOT_NOT_IN_GUILD" | "CHECK_FAILED"> };

interface CacheEntry {
  decision: MemberAccessDecision;
  timestamp: number;
}

/**
 * SEC-05 : filet de sécurité. Les changements connus (rôles d'un membre, permissions d'un rôle, rôle TO du serveur
 * ou d'un tournoi, archivage d'un tournoi, désactivation d'intégration SEC-26)
 * invalident l'entrée immédiatement ; ce délai ne couvre que les changements que Discord ne signale pas.
 */
const ACCESS_CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

const cacheKey = (tenantId: string, discordId: string) => `${tenantId}:${discordId}`;

export function clearMemberAccessCache(): void {
  cache.clear();
}

/** Un membre a changé (rôles, départ) : sa prochaine requête est revérifiée en direct. */
export function invalidateMemberAccess(tenantId: string, discordId: string): void {
  cache.delete(cacheKey(tenantId, discordId));
}

/** Un changement touche toute l'organisation ou tout le serveur (permissions, rôle TO, désactivation d'intégration). */
export function invalidateGuildAccess(tenantId: string): void {
  const prefix = `${tenantId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export const invalidateOrganizationAccess = invalidateGuildAccess;

function normalizeNativeRole(rawRole: unknown): OrganizationRole | null {
  if (rawRole === "ORG_OWNER" || rawRole === "OWNER") return "ORG_OWNER";
  if (rawRole === "ORG_ADMIN" || rawRole === "ADMIN") return "ORG_ADMIN";
  if (rawRole === "ORG_TO" || rawRole === "ORGANIZER") return "ORG_TO";
  return null;
}

function nativeRoleToServerReason(role: OrganizationRole): GuildAdminReason {
  if (role === "ORG_OWNER") return "SERVER_OWNER";
  if (role === "ORG_ADMIN") return "ADMINISTRATOR";
  return "TO_ROLE";
}

async function computeOrganizationAccess(
  client: DiscordClientLike,
  org: ResolvedOrganization,
  discordId: string,
): Promise<MemberAccessDecision> {
  // 1. Rôle natif au niveau de l'organisation (organization_members) — toujours actif même sans Discord
  const { data: memberRow, error: memberErr } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", discordId)
    .maybeSingle();

  if (memberErr) return { allowed: false, code: "CHECK_FAILED" };
  const nativeRole = normalizeNativeRole((memberRow as { role?: unknown } | null)?.role);
  if (nativeRole) {
    return {
      allowed: true,
      access: {
        level: "SERVER",
        reason: nativeRoleToServerReason(nativeRole),
        nativeRole,
        source: "NATIVE",
      },
    };
  }

  // 2. Tournois non archivés de l'organisation (pour tournament_staff et rôles Discord par tournoi)
  const { data: orgTournaments, error: tourneyErr } = await supabase
    .from("tournaments")
    .select("id, discord_to_role_id, status")
    .eq("organization_id", org.id)
    .neq("status", "ARCHIVED");

  if (tourneyErr) return { allowed: false, code: "CHECK_FAILED" };
  const activeTournaments = (orgTournaments ?? []) as { id: string; discord_to_role_id: string | null }[];
  const activeIds = activeTournaments.map((t) => t.id);

  const tournamentRolesMap: Record<string, TournamentStaffRole> = {};
  if (activeIds.length > 0) {
    const { data: staffRows, error: staffErr } = await supabase
      .from("tournament_staff")
      .select("tournament_id, role")
      .in("tournament_id", activeIds)
      .eq("user_id", discordId);
    if (staffErr) return { allowed: false, code: "CHECK_FAILED" };
    for (const row of (staffRows ?? []) as { tournament_id: string; role: TournamentStaffRole }[]) {
      if (row.role === "TOURNAMENT_TO" || row.role === "CASTER" || row.role === "STATISTICIAN") {
        tournamentRolesMap[row.tournament_id] = row.role;
      }
    }
  }

  // 3. SEC-26 : Source d'accès Discord évaluée UNIQUEMENT si l'intégration DISCORD est active (`enabled = true`)
  if (org.discordEnabled && org.discordGuildId) {
    const guild = await client.guilds.fetch(org.discordGuildId).catch(() => null);
    if (guild) {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member) {
        const configToRole =
          typeof org.discordConfig.to_role_id === "string" && org.discordConfig.to_role_id.length > 0
            ? org.discordConfig.to_role_id
            : null;
        const reason = resolveAdminReason({
          isOwner: guild.ownerId === discordId,
          hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
          hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
          hasToRole: !!configToRole && member.roles.cache.has(configToRole),
        });
        if (reason) {
          return { allowed: true, access: { level: "SERVER", reason } };
        }

        for (const t of activeTournaments) {
          if (t.discord_to_role_id && member.roles.cache.has(t.discord_to_role_id)) {
            tournamentRolesMap[t.id] = "TOURNAMENT_TO";
          }
        }
      } else if (Object.keys(tournamentRolesMap).length === 0) {
        return { allowed: false, code: "NOT_A_MEMBER" };
      }
    } else if (Object.keys(tournamentRolesMap).length === 0) {
      return { allowed: false, code: "BOT_NOT_IN_GUILD" };
    }
  }

  const scopedTournamentIds = Object.keys(tournamentRolesMap);
  if (scopedTournamentIds.length > 0) {
    return {
      allowed: true,
      access: {
        level: "TOURNAMENT",
        tournamentIds: scopedTournamentIds,
        tournamentRoles: tournamentRolesMap,
        source: "NATIVE",
      },
    };
  }

  return { allowed: false, code: "NO_RIGHTS" };
}

async function computeAccess(client: DiscordClientLike, guildIdOrOrg: string, discordId: string): Promise<MemberAccessDecision> {
  const org = await resolveOrganization(guildIdOrOrg).catch(() => null);
  if (org) {
    return computeOrganizationAccess(client, org, discordId);
  }

  const guild = await client.guilds.fetch(guildIdOrOrg).catch(() => null);
  if (!guild) return { allowed: false, code: "BOT_NOT_IN_GUILD" };

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { allowed: false, code: "NOT_A_MEMBER" };

  const settings = await readToRoleId(guildIdOrOrg);
  if (!settings.ok) return { allowed: false, code: "CHECK_FAILED" };

  const reason = resolveAdminReason({
    isOwner: guild.ownerId === discordId,
    hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    hasToRole: !!settings.toRoleId && member.roles.cache.has(settings.toRoleId),
  });
  // Le niveau SERVER l'emporte : les rôles TO de tournoi ne sont lus que sans droit serveur.
  if (reason) return { allowed: true, access: { level: "SERVER", reason } };

  const tournamentRoles = await readTournamentToRoles(guildIdOrOrg);
  if (!tournamentRoles.ok) return { allowed: false, code: "CHECK_FAILED" };
  const tournamentIds = tournamentRoles.roles
    .filter((role) => member.roles.cache.has(role.roleId))
    .map((role) => role.tournamentId);
  return tournamentIds.length > 0
    ? { allowed: true, access: { level: "TOURNAMENT", tournamentIds } }
    : { allowed: false, code: "NO_RIGHTS" };
}

/**
 * Décision unique d'accès au back-office (SEC-11), partagée par requireGuildAdmin (actions) et
 * /api/discord/permissions (affichage du panel web) : mêmes lectures, même cache, même invalidation.
 * Les pannes (CHECK_FAILED) et l'absence du bot ne sont jamais mises en cache.
 */
export async function resolveMemberAccess(
  client: DiscordClientLike,
  guildId: string,
  discordId: string,
): Promise<MemberAccessDecision> {
  const key = cacheKey(guildId, discordId);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.timestamp < ACCESS_CACHE_TTL_MS) return cached.decision;

  const decision = await computeAccess(client, guildId, discordId);
  const cacheable = decision.allowed || decision.code === "NO_RIGHTS" || decision.code === "NOT_A_MEMBER";
  if (cacheable) cache.set(key, { decision, timestamp: now });
  else cache.delete(key);
  return decision;
}
