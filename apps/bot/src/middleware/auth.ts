import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { PermissionFlagsBits } from "discord.js";
import type { GuildAdminReason } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { resolveAdminReason } from "../utils/adminAccess";

export interface AdminCheck {
  discordId: string;
  guildId: string;
  reason: GuildAdminReason;
}

declare module "express-serve-static-core" {
  interface Request {
    adminCheck?: AdminCheck;
  }
}

function secretMatches(token: string): boolean {
  const secret = process.env.BOT_API_SECRET || "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authentifie les appels service-à-service (Next.js ➜ bot) par le secret partagé BOT_API_SECRET.
 * Le navigateur ne parle jamais directement au bot : il passe par le proxy /api/bot qui injecte ce secret
 * et l'identité Discord issue de la session serveur (SEC-06).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") return next();

  if (!process.env.BOT_API_SECRET) {
    return res.status(500).json({ error: "Server auth misconfiguration" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  if (!secretMatches(authHeader.slice(7))) {
    return res.status(401).json({ error: "Invalid token" });
  }
  next();
}

interface PermCacheEntry {
  adminCheck: AdminCheck | null;
  timestamp: number;
}

const permCache = new Map<string, PermCacheEntry>();
const PERM_CACHE_TTL_MS = 30_000; // SEC-05 : délai maximal de prise en compte d'une perte de droits.

export function clearPermissionCache() {
  permCache.clear();
}

/** Sous-ensemble du client Discord utilisé (facilite les tests). */
interface DiscordClientLike {
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

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Exige que l'utilisateur (X-Discord-User-Id, injecté par le proxy) administre le serveur ciblé :
 * propriétaire, Administrateur, Gérer le serveur ou rôle TO configuré (règle unique resolveAdminReason).
 */
export function requireGuildAdmin(discordClient: DiscordClientLike) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const discordId = firstString(req.headers["x-discord-user-id"]);
    const guildId = firstString(
      req.body?.guildId,
      req.body?.guild_id,
      req.query?.guildId,
      req.query?.guild_id,
      req.headers["x-guild-id"],
    );

    if (!discordId) {
      return res.status(401).json({ error: "User identity required" });
    }
    if (!guildId) {
      return res.status(400).json({ error: "guildId required — provide in body, query, or X-Guild-Id header" });
    }

    const cacheKey = `${guildId}:${discordId}`;
    const cached = permCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < PERM_CACHE_TTL_MS) {
      if (!cached.adminCheck) return res.status(403).json({ error: "Insufficient Discord permissions" });
      req.adminCheck = cached.adminCheck;
      return next();
    }

    const guild = await discordClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res.status(404).json({ error: "Guild not found" });
    }

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      permCache.set(cacheKey, { adminCheck: null, timestamp: now });
      return res.status(403).json({ error: "User not found in guild" });
    }

    const { data: settings, error } = await supabase
      .from("server_settings")
      .select("to_role_id")
      .eq("guild_id", guildId)
      .maybeSingle();
    if (error) {
      logger.error(`[Auth] Lecture du rôle TO impossible pour ${guildId}:`, error);
      return res.status(503).json({ error: "Permission check temporarily unavailable" });
    }

    const toRoleId = (settings as { to_role_id: string | null } | null)?.to_role_id ?? null;
    const reason = resolveAdminReason({
      isOwner: guild.ownerId === discordId,
      hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
      hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
      hasToRole: !!toRoleId && member.roles.cache.has(toRoleId),
    });

    const adminCheck = reason ? { discordId, guildId, reason } : null;
    permCache.set(cacheKey, { adminCheck, timestamp: now });

    if (!adminCheck) {
      return res.status(403).json({ error: "Insufficient Discord permissions" });
    }
    req.adminCheck = adminCheck;
    next();
  };
}
