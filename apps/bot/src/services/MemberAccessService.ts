import { PermissionFlagsBits } from "discord.js";
import {
  isDiscordSnowflake,
  readTournamentDiscordConfig,
  type AccessDeniedCode,
  type GuildAccess,
  type GuildAdminReason,
  type OrganizationRole,
  type TournamentStaffRole,
} from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { resolveAdminReason } from "../utils/adminAccess";
import { resolveOrganization, type ResolvedOrganization } from "../utils/tenant";

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

/**
 * SEC-18 : droits de gestion réels sur un serveur, sans le rôle TO (qui dépend déjà d'un rattachement).
 * Le bot doit être présent : sans lui, aucune vérification fiable n'est possible.
 */
export async function checkGuildManageRights(
  client: DiscordClientLike,
  guildId: string,
  discordId: string,
): Promise<"OK" | "NO_RIGHTS" | "BOT_NOT_IN_GUILD"> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return "BOT_NOT_IN_GUILD";
  if (guild.ownerId === discordId) return "OK";
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return "NO_RIGHTS";
  return member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)
    ? "OK"
    : "NO_RIGHTS";
}

function normalizeNativeRole(rawRole: unknown): OrganizationRole | null {
  if (rawRole === "ORG_OWNER") return "ORG_OWNER";
  if (rawRole === "ORG_ADMIN") return "ORG_ADMIN";
  if (rawRole === "ORG_TO") return "ORG_TO";
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
  const rawNativeRole = (memberRow as { role?: unknown } | null)?.role;
  const nativeRole = normalizeNativeRole(rawNativeRole);
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
    .select("id, discord_config, status")
    .eq("organization_id", org.id)
    .neq("status", "ARCHIVED");

  if (tourneyErr) return { allowed: false, code: "CHECK_FAILED" };
  const activeTournaments = (orgTournaments ?? []) as { id: string; discord_config?: unknown }[];
  const activeIds = activeTournaments.map((t) => t.id);

  const tournamentRolesMap: Record<string, TournamentStaffRole> = {};
  // RFC Q2 : casteur / statisticien d'organisation = même périmètre que le rôle de tournoi, sur chaque tournoi non archivé.
  // Ils restent de niveau TOURNAMENT : aucune route réservée au niveau SERVER ne leur est ouverte.
  if (rawNativeRole === "CASTER" || rawNativeRole === "STATISTICIAN") {
    for (const id of activeIds) tournamentRolesMap[id] = rawNativeRole;
  }
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

  const hasNativeTournamentAccess = Object.keys(tournamentRolesMap).length > 0;

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
          const toRoleId = readTournamentDiscordConfig(t.discord_config).to_role_id;
          if (toRoleId && member.roles.cache.has(toRoleId)) {
            tournamentRolesMap[t.id] = "TOURNAMENT_TO";
          }
        }
      } else if (!hasNativeTournamentAccess) {
        return { allowed: false, code: "NOT_A_MEMBER" };
      }
    } else if (!hasNativeTournamentAccess) {
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
        source: hasNativeTournamentAccess ? "NATIVE" : "DISCORD",
      },
    };
  }

  return { allowed: false, code: "NO_RIGHTS" };
}

async function computeAccess(client: DiscordClientLike, guildIdOrOrg: string, discordId: string): Promise<MemberAccessDecision> {
  let org: ResolvedOrganization | null = null;
  try {
    org = await resolveOrganization(guildIdOrOrg);
  } catch (error) {
    logger.error(`[MemberAccess] Erreur lors de la résolution de l'organisation pour ${guildIdOrOrg}:`, error);
    return { allowed: false, code: "CHECK_FAILED" };
  }
  if (!org) {
    return { allowed: false, code: isDiscordSnowflake(guildIdOrOrg) ? "BOT_NOT_IN_GUILD" : "NO_RIGHTS" };
  }
  return computeOrganizationAccess(client, org, discordId);
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
