import { PermissionFlagsBits } from "discord.js";
import type { AccessDeniedCode, GuildAccess } from "@hub/shared";
import { resolveAdminReason } from "../utils/adminAccess";
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
 * ou d'un tournoi, archivage d'un tournoi)
 * invalident l'entrée immédiatement ; ce délai ne couvre que les changements que Discord ne signale pas.
 */
const ACCESS_CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

const cacheKey = (guildId: string, discordId: string) => `${guildId}:${discordId}`;

export function clearMemberAccessCache(): void {
  cache.clear();
}

/** Un membre a changé (rôles, départ) : sa prochaine requête est revérifiée en direct. */
export function invalidateMemberAccess(guildId: string, discordId: string): void {
  cache.delete(cacheKey(guildId, discordId));
}

/** Un changement touche tout le serveur (permissions d'un rôle, rôle TO, propriétaire). */
export function invalidateGuildAccess(guildId: string): void {
  const prefix = `${guildId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

async function computeAccess(client: DiscordClientLike, guildId: string, discordId: string): Promise<MemberAccessDecision> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { allowed: false, code: "BOT_NOT_IN_GUILD" };

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { allowed: false, code: "NOT_A_MEMBER" };

  const settings = await readToRoleId(guildId);
  if (!settings.ok) return { allowed: false, code: "CHECK_FAILED" };

  const reason = resolveAdminReason({
    isOwner: guild.ownerId === discordId,
    hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    hasToRole: !!settings.toRoleId && member.roles.cache.has(settings.toRoleId),
  });
  // Le niveau SERVER l'emporte : les rôles TO de tournoi ne sont lus que sans droit serveur.
  if (reason) return { allowed: true, access: { level: "SERVER", reason } };

  const tournamentRoles = await readTournamentToRoles(guildId);
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
