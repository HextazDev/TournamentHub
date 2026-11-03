import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { canPerform, type AccessDeniedCode, type GuildAccess, type GuildAction } from "@hub/shared";
import { logger } from "../utils/logger";
import { resolveMemberAccess, type DiscordClientLike, type MemberAccessDecision } from "../services/MemberAccessService";

export interface AdminCheck {
  discordId: string;
  guildId: string;
  access: GuildAccess;
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

/** Refus d'accès structuré : `code` permet au web d'afficher un message traduit (jamais le texte brut). */
function deny(res: Response, status: number, code: AccessDeniedCode, error: string) {
  return res.status(status).json({ error, code });
}

type DeniedDecision = Extract<MemberAccessDecision, { allowed: false }>;

const DENIAL_RESPONSES: Record<DeniedDecision["code"], { status: number; error: string }> = {
  BOT_NOT_IN_GUILD: { status: 404, error: "Guild not found" },
  NOT_A_MEMBER: { status: 403, error: "User not found in guild" },
  NO_RIGHTS: { status: 403, error: "Insufficient Discord permissions" },
  CHECK_FAILED: { status: 503, error: "Permission check temporarily unavailable" },
};

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Exige que l'utilisateur (X-Discord-User-Id, injecté par le proxy) administre le serveur ciblé :
 * propriétaire, Administrateur, Gérer le serveur ou rôle TO configuré (décision unique resolveMemberAccess).
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
      return deny(res, 401, "NOT_LOGGED_IN", "User identity required");
    }
    if (!guildId) {
      return res.status(400).json({ error: "guildId required — provide in body, query, or X-Guild-Id header" });
    }

    const decision = await resolveMemberAccess(discordClient, guildId, discordId);
    if (!decision.allowed) {
      const { status, error } = DENIAL_RESPONSES[decision.code];
      return deny(res, status, decision.code, error);
    }
    req.adminCheck = { discordId, guildId, access: decision.access };
    next();
  };
}

const ACTION_DENIED_CODE: Record<GuildAction, AccessDeniedCode> = {
  MANAGE_SERVER_SETTINGS: "SERVER_SETTINGS_RESERVED",
  CREATE_TOURNAMENT: "NO_RIGHTS",
  DELETE_TOURNAMENT: "NO_RIGHTS",
  MANAGE_TOURNAMENT: "NO_RIGHTS",
};

/**
 * À placer après requireGuildAdmin : restreint une route à une action précise (canPerform, SEC-16).
 * Sans adminCheck (garde mal montée), la requête est refusée.
 */
export function requireGuildAction(action: GuildAction) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminCheck || !canPerform(req.adminCheck.access, action)) {
      return deny(res, 403, ACTION_DENIED_CODE[action], "Action reserved to server managers");
    }
    next();
  };
}

/**
 * GET /api/discord/permissions — décision d'accès pour le panel web (appel serveur Next.js uniquement :
 * le proxy /api/bot ne relaie pas cette route, cf. SEC-13). Même décision et même cache que requireGuildAdmin.
 */
export function guildPermissionsHandler(discordClient: DiscordClientLike) {
  return async (req: Request, res: Response) => {
    const guildId = typeof req.query.guildId === "string" ? req.query.guildId : "";
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    if (!guildId || !userId) return res.status(400).json({ error: "Missing parameters" });

    try {
      const decision = await resolveMemberAccess(discordClient, guildId, userId);
      if (decision.allowed) return res.status(200).json({ hasPermission: true, access: decision.access });
      if (decision.code === "CHECK_FAILED") {
        return deny(res, 503, "CHECK_FAILED", DENIAL_RESPONSES.CHECK_FAILED.error);
      }
      return res.status(200).json({ hasPermission: false, reason: decision.code });
    } catch (error) {
      logger.error("[Auth] Vérification des permissions impossible:", error);
      return deny(res, 500, "CHECK_FAILED", "Internal Server Error");
    }
  };
}
