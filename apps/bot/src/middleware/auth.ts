import { Request, Response, NextFunction, type RequestHandler } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { timingSafeEqual } from "crypto";
import {
  canPerform,
  type AccessDeniedCode,
  type GuildAccess,
  type OrganizationAccess,
  type OrganizationAction,
} from "@hub/shared";
import { logger } from "../utils/logger";
import { resolveMemberAccess, type DiscordClientLike, type MemberAccessDecision } from "../services/MemberAccessService";
import { resolveResourceTournament, type TournamentResourceKind } from "../utils/tenant";

export interface AdminCheck {
  discordId: string;
  guildId: string;
  access: GuildAccess | OrganizationAccess;
}

/** Tournoi dont l'accès a été vérifié par requireTournamentScope pour cette requête (SEC-21). */
export interface TournamentScope {
  tournamentId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    adminCheck?: AdminCheck;
    tournamentScope?: TournamentScope;
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

export interface GuildAdminOptions {
  /**
   * SEC-21 : accepte aussi un TO de tournoi (niveau TOURNAMENT). À réserver aux montages dont chaque route
   * déclare requireTournamentScope ou requireServerLevel ; partout ailleurs, le niveau SERVER est exigé.
   */
  tournamentLevel?: boolean;
}

const SERVER_LEVEL_ERROR = "Action reserved to server managers";

/**
 * Exige que l'utilisateur (X-Discord-User-Id, injecté par le proxy) administre le serveur ciblé :
 * propriétaire, Administrateur, Gérer le serveur ou rôle TO configuré (décision unique resolveMemberAccess).
 * Un TO de tournoi n'est accepté que sur un montage `{ tournamentLevel: true }` (fermé par défaut, SEC-21).
 */
export function requireGuildAdmin(discordClient: DiscordClientLike, options: GuildAdminOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const discordId = firstString(req.headers["x-discord-user-id"]);
    const guildId = firstString(
      req.body?.guildId,
      req.body?.guild_id,
      req.body?.organizationId,
      req.body?.organization_id,
      req.query?.guildId,
      req.query?.guild_id,
      req.query?.organizationId,
      req.query?.organization_id,
      req.headers["x-guild-id"],
      req.headers["x-organization-id"],
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
    if (decision.access.level !== "SERVER" && options.tournamentLevel !== true) {
      return deny(res, 403, "SERVER_LEVEL_REQUIRED", SERVER_LEVEL_ERROR);
    }
    req.adminCheck = { discordId, guildId, access: decision.access };
    next();
  };
}

/** Marque des gardes de route : le test statique vérifie que chaque route d'un montage ouvert en déclare une. */
export const ROUTE_GUARD = Symbol("routeGuard");
export type RouteGuardKind = "server" | "tournament";

/**
 * Garde typée par les paramètres d'URL qu'elle lit (`param("id")` ➜ `{ id: string }`) : insérée entre le chemin
 * et le handler, elle laisse Express inférer `req.params` de la route au lieu d'imposer ParamsDictionary.
 */
export type TaggedGuard<P extends ParamsDictionary = Record<never, string>> = RequestHandler<P> & {
  [ROUTE_GUARD]: RouteGuardKind;
};

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

function tagGuard<P extends ParamsDictionary>(kind: RouteGuardKind, handler: Guard): TaggedGuard<P> {
  return Object.assign(handler, { [ROUTE_GUARD]: kind });
}

export function routeGuardKind(handler: unknown): RouteGuardKind | null {
  if (typeof handler !== "function" || !(ROUTE_GUARD in handler)) return null;
  const kind: unknown = Reflect.get(handler, ROUTE_GUARD);
  return kind === "server" || kind === "tournament" ? kind : null;
}

/**
 * SEC-21 : route réservée au niveau SERVER dans un montage ouvert aux TO de tournoi
 * (création de tournoi…). Sans adminCheck (garde mal montée), la requête est refusée.
 */
export const requireServerLevel: TaggedGuard = tagGuard("server", (req, res, next) => {
  if (req.adminCheck?.access.level !== "SERVER") {
    return deny(res, 403, "SERVER_LEVEL_REQUIRED", SERVER_LEVEL_ERROR);
  }
  next();
});

type DirectSource = { kind: "param" | "body" | "query"; key: string };
type ResourceSource = { kind: TournamentResourceKind; param: string };

/** Origine du tournoi d'une requête, toujours lue côté serveur (URL, base) ou vérifiée avant usage (corps, query). */
export interface TournamentSource<P extends ParamsDictionary> {
  readonly from: DirectSource | ResourceSource;
  /** Paramètres d'URL lus par la garde (type uniquement). */
  readonly params?: P;
}

const urlSource = <K extends string>(from: DirectSource | ResourceSource): TournamentSource<Record<K, string>> => ({ from });

export const tournamentFrom = {
  /** :id du tournoi dans l'URL. */
  param: <K extends string>(key: K) => urlSource<K>({ kind: "param", key }),
  /** Création (phase, équipe…) : le handler n'utilise ensuite que getTournamentScope(req). */
  body: (key: string): TournamentSource<Record<never, string>> => ({ from: { kind: "body", key } }),
  query: (key: string): TournamentSource<Record<never, string>> => ({ from: { kind: "query", key } }),
  /** :id d'une phase, d'un match ou d'une équipe : son tournoi est lu en base. */
  phase: <K extends string>(param: K) => urlSource<K>({ kind: "phase", param }),
  match: <K extends string>(param: K) => urlSource<K>({ kind: "match", param }),
  team: <K extends string>(param: K) => urlSource<K>({ kind: "team", param }),
};

function isDirect(source: DirectSource | ResourceSource): source is DirectSource {
  return source.kind === "param" || source.kind === "body" || source.kind === "query";
}

function readSource(req: Request, source: DirectSource | ResourceSource): unknown {
  if (!isDirect(source)) return req.params[source.param];
  if (source.kind === "param") return req.params[source.key];
  if (source.kind === "query") return req.query[source.key];
  const body: unknown = req.body;
  return typeof body === "object" && body !== null ? Reflect.get(body, source.key) : undefined;
}

export interface TournamentScopeOptions {
  /** Le niveau SERVER peut omettre l'identifiant (listes Discord appelées hors tournoi). */
  optionalForServer?: boolean;
  /** Action exigée sur le tournoi : gestion complète par défaut, saisie de score pour le statisticien (RFC 5.1). */
  action?: OrganizationAction;
}

/**
 * SEC-21 : seule porte d'entrée d'un TO de tournoi. Le tournoi est résolu côté serveur puis soumis à
 * canPerform(access, "MANAGE_TOURNAMENT", tournamentId). Les tournamentIds de l'accès étant lus pour ce seul
 * serveur, l'appartenance au serveur est garantie ; les handlers gardent leurs verify*Guild (SEC-01).
 * Le niveau SERVER passe sans lecture supplémentaire.
 */
export function requireTournamentScope<P extends ParamsDictionary>(
  { from: source }: TournamentSource<P>,
  options: TournamentScopeOptions = {},
): TaggedGuard<P> {
  return tagGuard<P>("tournament", async (req, res, next) => {
    const check = req.adminCheck;
    if (!check) return deny(res, 403, "NO_RIGHTS", "Access denied");

    const raw = readSource(req, source);
    if (typeof raw !== "string" || raw.length === 0) {
      if (raw === undefined && options.optionalForServer === true && check.access.level === "SERVER") return next();
      return res.status(400).json({ error: "Tournament identifier required" });
    }

    if (check.access.level === "SERVER") {
      if (isDirect(source)) req.tournamentScope = { tournamentId: raw };
      return next();
    }

    let tournamentId: string | null = raw;
    if (!isDirect(source)) {
      const lookup = await resolveResourceTournament(source.kind, raw);
      if (!lookup.ok) return deny(res, 503, "CHECK_FAILED", DENIAL_RESPONSES.CHECK_FAILED.error);
      tournamentId = lookup.tournamentId;
    }
    if (!tournamentId || !canPerform(check.access, options.action ?? "MANAGE_TOURNAMENT", tournamentId)) {
      return deny(res, 403, "NO_RIGHTS", "Access denied");
    }
    req.tournamentScope = { tournamentId };
    next();
  });
}

const ACTION_DENIED_CODE: Record<OrganizationAction, AccessDeniedCode> = {
  MANAGE_SERVER_SETTINGS: "SERVER_SETTINGS_RESERVED",
  MANAGE_ORG_SETTINGS: "SERVER_SETTINGS_RESERVED",
  MANAGE_INTEGRATIONS: "SERVER_SETTINGS_RESERVED",
  MANAGE_ORG_MEMBERS: "SERVER_SETTINGS_RESERVED",
  TRANSFER_OWNERSHIP: "SERVER_SETTINGS_RESERVED",
  DELETE_ORGANIZATION: "SERVER_SETTINGS_RESERVED",
  CREATE_TOURNAMENT: "NO_RIGHTS",
  DELETE_TOURNAMENT: "NO_RIGHTS",
  MANAGE_TOURNAMENT: "NO_RIGHTS",
  MANAGE_TOURNAMENT_ROLES: "TOURNAMENT_ROLES_RESERVED",
  SCORE_MATCH: "NO_RIGHTS",
  VIEW_PRIVATE_TOURNAMENT: "NO_RIGHTS",
};

/**
 * À placer après requireGuildAdmin : restreint une route à une action précise (canPerform, SEC-16).
 * Sans adminCheck (garde mal montée), la requête est refusée.
 */
export function requireGuildAction(action: OrganizationAction) {
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
    const guildId = firstString(req.query.guildId, req.query.organizationId) ?? "";
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
