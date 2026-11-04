import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null, failTournaments: false }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      if (table === "tournaments" && db.failTournaments) {
        const failing = {
          select: () => failing,
          eq: () => failing,
          neq: () => failing,
          not: () => failing,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "down" } }).then(resolve),
        };
        return failing;
      }
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { GuildAccess } from "@hub/shared";
import {
  requireGuildAdmin,
  requireServerLevel,
  requireTournamentScope,
  tournamentFrom,
  type AdminCheck,
} from "../middleware/auth";
import {
  clearMemberAccessCache,
  invalidateGuildAccess,
  invalidateMemberAccess,
  resolveMemberAccess,
} from "../services/MemberAccessService";
import { getAuthenticatedGuildId, getTournamentScope } from "../utils/tenant";

const GUILD = "g1";
const T_A = "tournament-a";
const T_B = "tournament-b";

function seed(tournaments: Record<string, unknown>[]) {
  db.failTournaments = false;
  db.current = new FakeSupabase({
    server_settings: [{ guild_id: GUILD, to_role_id: "server-to" }],
    tournaments,
    phases: [
      { id: "phase-a", tournament_id: T_A },
      { id: "phase-b", tournament_id: T_B },
    ],
    matches: [
      { id: "match-a", phase_id: "phase-a" },
      { id: "match-b", phase_id: "phase-b" },
    ],
    teams: [
      { id: "team-a", tournament_id: T_A },
      { id: "team-b", tournament_id: T_B },
    ],
  });
}

const tournament = (id: string, roleId: string | null, status = "ACTIVE", guildId = GUILD) => ({
  id,
  guild_id: guildId,
  status,
  discord_to_role_id: roleId,
});

interface FakeMember {
  roles: string[];
  admin?: boolean;
}

function discord(member: FakeMember | null) {
  return {
    guilds: {
      fetch: () =>
        Promise.resolve({
          ownerId: "owner",
          members: {
            fetch: () =>
              member
                ? Promise.resolve({
                    permissions: { has: (flag: bigint) => flag === 8n && !!member.admin },
                    roles: { cache: { has: (id: string) => member.roles.includes(id) } },
                  })
                : Promise.reject(new Error("Unknown Member")),
          },
        }),
    },
  };
}

function res() {
  const r = { statusCode: 200, body: undefined as unknown };
  const out = {
    status: (code: number) => ((r.statusCode = code), out),
    json: (body: unknown) => ((r.body = body), out),
  };
  return { r, out: out as unknown as Response };
}

function req<P extends ParamsDictionary = ParamsDictionary>(partial: Record<string, unknown> = {}): Request<P> {
  return {
    path: "/api/x",
    body: {},
    query: {},
    params: {},
    headers: { "x-discord-user-id": "u1", "x-guild-id": GUILD },
    ...partial,
  } as unknown as Request<P>;
}

async function run<P extends ParamsDictionary>(mw: (q: Request<P>, s: Response, n: NextFunction) => unknown, q: Request<P>) {
  const { r, out } = res();
  const next = vi.fn();
  await mw(q, out, next);
  return { ...r, next };
}

const scoped = (ids: string[]): AdminCheck => ({ discordId: "u1", guildId: GUILD, access: { level: "TOURNAMENT", tournamentIds: ids } });
const server: AdminCheck = { discordId: "u1", guildId: GUILD, access: { level: "SERVER", reason: "TO_ROLE" } };

beforeEach(() => {
  clearMemberAccessCache();
  seed([tournament(T_A, "role-a"), tournament(T_B, "role-b")]);
});

describe("resolveMemberAccess : niveau TOURNAMENT (#67)", () => {
  it("SEC-21: le rôle TO d'un tournoi donne un accès limité à ce tournoi", async () => {
    const decision = await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1");
    expect(decision).toEqual({ allowed: true, access: { level: "TOURNAMENT", tournamentIds: [T_A] } });
  });

  it("SEC-21: plusieurs rôles TO de tournoi cumulent leurs tournois", async () => {
    const decision = await resolveMemberAccess(discord({ roles: ["role-a", "role-b"] }), GUILD, "u1");
    expect(decision.allowed && decision.access).toEqual({ level: "TOURNAMENT", tournamentIds: [T_A, T_B] });
  });

  it("SEC-23: un tournoi archivé ne donne aucun accès ; un tournoi terminé (COMPLETED) en donne", async () => {
    seed([tournament(T_A, "role-a", "ARCHIVED"), tournament(T_B, "role-b", "COMPLETED")]);
    expect(await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).toEqual({ allowed: false, code: "NO_RIGHTS" });
    clearMemberAccessCache();
    expect(await resolveMemberAccess(discord({ roles: ["role-b"] }), GUILD, "u1")).toEqual({
      allowed: true,
      access: { level: "TOURNAMENT", tournamentIds: [T_B] },
    });
  });

  it("SEC-21: le rôle TO d'un tournoi d'un autre serveur ne compte pas", async () => {
    seed([tournament(T_A, "role-a", "ACTIVE", "other-guild")]);
    expect(await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).toEqual({ allowed: false, code: "NO_RIGHTS" });
  });

  it("SEC-21: le niveau SERVER l'emporte sur un rôle TO de tournoi", async () => {
    const decision = await resolveMemberAccess(discord({ roles: ["server-to", "role-a"] }), GUILD, "u1");
    expect(decision).toEqual({ allowed: true, access: { level: "SERVER", reason: "TO_ROLE" } });
    clearMemberAccessCache();
    const admin = await resolveMemberAccess(discord({ roles: ["role-a"], admin: true }), GUILD, "u1");
    expect(admin).toEqual({ allowed: true, access: { level: "SERVER", reason: "ADMINISTRATOR" } });
  });

  it("SEC-04: une panne de lecture des tournois renvoie CHECK_FAILED, jamais mis en cache", async () => {
    db.failTournaments = true;
    expect(await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).toEqual({ allowed: false, code: "CHECK_FAILED" });
    db.failTournaments = false;
    expect((await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).allowed).toBe(true);
  });

  it("SEC-23 / SEC-05: un rôle retiré dans Discord retire l'accès dès l'invalidation du membre", async () => {
    const member = { roles: ["role-a"] };
    expect((await resolveMemberAccess(discord(member), GUILD, "u1")).allowed).toBe(true);
    member.roles = [];
    invalidateMemberAccess(GUILD, "u1");
    expect(await resolveMemberAccess(discord(member), GUILD, "u1")).toEqual({ allowed: false, code: "NO_RIGHTS" });
  });

  it("SEC-05: un changement de discord_to_role_id prend effet dès l'invalidation du serveur", async () => {
    expect((await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).allowed).toBe(true);
    const row = db.current?.tables.tournaments?.find((t) => t.id === T_A);
    if (!row) throw new Error("tournoi absent du jeu de test");
    row.discord_to_role_id = "role-new";
    // Sans invalidation, le cache garde l'ancienne décision (TTL 30 s)…
    expect((await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).allowed).toBe(true);
    invalidateGuildAccess(GUILD);
    expect(await resolveMemberAccess(discord({ roles: ["role-a"] }), GUILD, "u1")).toEqual({ allowed: false, code: "NO_RIGHTS" });
  });
});

describe("requireGuildAdmin : niveau SERVER exigé par défaut (SEC-21)", () => {
  it("refuse un TO de tournoi avec 403 SERVER_LEVEL_REQUIRED sans option explicite", async () => {
    const out = await run(requireGuildAdmin(discord({ roles: ["role-a"] })), req());
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ code: "SERVER_LEVEL_REQUIRED" });
    expect(out.next).not.toHaveBeenCalled();
  });

  it("laisse passer un TO de tournoi uniquement sur un montage { tournamentLevel: true }", async () => {
    const q = req();
    const out = await run(requireGuildAdmin(discord({ roles: ["role-a"] }), { tournamentLevel: true }), q);
    expect(out.next).toHaveBeenCalled();
    expect(q.adminCheck?.access).toEqual({ level: "TOURNAMENT", tournamentIds: [T_A] });
  });

  it("le niveau SERVER passe sur les deux montages", async () => {
    for (const mw of [requireGuildAdmin(discord({ roles: ["server-to"] })), requireGuildAdmin(discord({ roles: ["server-to"] }), { tournamentLevel: true })]) {
      clearMemberAccessCache();
      const out = await run(mw, req());
      expect(out.next).toHaveBeenCalled();
    }
  });
});

describe("requireServerLevel (SEC-21)", () => {
  it("refuse le niveau TOURNAMENT et une garde mal montée, laisse passer le niveau SERVER", async () => {
    const denied = await run(requireServerLevel, req({ adminCheck: scoped([T_A]) }));
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({ code: "SERVER_LEVEL_REQUIRED" });
    expect((await run(requireServerLevel, req())).statusCode).toBe(403);
    expect((await run(requireServerLevel, req({ adminCheck: server }))).next).toHaveBeenCalled();
  });
});

describe("requireTournamentScope : tournoi résolu côté serveur (SEC-21)", () => {
  const cases: { name: string; resolver: Parameters<typeof requireTournamentScope>[0]; own: Record<string, unknown>; other: Record<string, unknown> }[] = [
    { name: "URL (:id)", resolver: tournamentFrom.param("id"), own: { params: { id: T_A } }, other: { params: { id: T_B } } },
    { name: "corps (création)", resolver: tournamentFrom.body("tournament_id"), own: { body: { tournament_id: T_A } }, other: { body: { tournament_id: T_B } } },
    { name: "query", resolver: tournamentFrom.query("tournamentId"), own: { query: { tournamentId: T_A } }, other: { query: { tournamentId: T_B } } },
    { name: "phase (base)", resolver: tournamentFrom.phase("id"), own: { params: { id: "phase-a" } }, other: { params: { id: "phase-b" } } },
    { name: "match (base)", resolver: tournamentFrom.match("id"), own: { params: { id: "match-a" } }, other: { params: { id: "match-b" } } },
    { name: "équipe (base)", resolver: tournamentFrom.team("id"), own: { params: { id: "team-a" } }, other: { params: { id: "team-b" } } },
  ];

  it.each(cases)("$name : le TO du tournoi A passe et la portée est posée", async ({ resolver, own }) => {
    const q = req({ adminCheck: scoped([T_A]), ...own });
    const out = await run(requireTournamentScope(resolver), q);
    expect(out.next).toHaveBeenCalled();
    expect(getTournamentScope(q)).toBe(T_A);
    expect(getAuthenticatedGuildId(q)).toBe(GUILD);
  });

  it.each(cases)("$name : le TO du tournoi A reçoit 403 sur le tournoi B du même serveur", async ({ resolver, other }) => {
    const q = req({ adminCheck: scoped([T_A]), ...other });
    const out = await run(requireTournamentScope(resolver), q);
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ code: "NO_RIGHTS" });
    expect(out.next).not.toHaveBeenCalled();
    expect(getTournamentScope(q)).toBeNull();
  });

  it("une ressource inconnue est refusée au TO de tournoi (403, pas de fuite d'existence)", async () => {
    const out = await run(requireTournamentScope(tournamentFrom.phase("id")), req({ adminCheck: scoped([T_A]), params: { id: "nope" } }));
    expect(out.statusCode).toBe(403);
  });

  it("un identifiant absent ou non textuel renvoie 400", async () => {
    for (const q of [req({ adminCheck: scoped([T_A]) }), req({ adminCheck: scoped([T_A]), body: { tournament_id: 42 } })]) {
      const out = await run(requireTournamentScope(tournamentFrom.body("tournament_id")), q);
      expect(out.statusCode).toBe(400);
    }
  });

  it("le niveau SERVER passe sans lecture en base ; la portée vient de l'URL ou du corps", async () => {
    const q = req({ adminCheck: server, body: { tournament_id: T_B } });
    const out = await run(requireTournamentScope(tournamentFrom.body("tournament_id")), q);
    expect(out.next).toHaveBeenCalled();
    expect(getTournamentScope(q)).toBe(T_B);
    const viaPhase = req<{ id: string }>({ adminCheck: server, params: { id: "phase-b" } });
    expect((await run(requireTournamentScope(tournamentFrom.phase("id")), viaPhase)).next).toHaveBeenCalled();
  });

  it("query optionnelle pour le niveau SERVER, obligatoire pour le niveau TOURNAMENT", async () => {
    const guard = requireTournamentScope(tournamentFrom.query("tournamentId"), { optionalForServer: true });
    expect((await run(guard, req({ adminCheck: server }))).next).toHaveBeenCalled();
    expect((await run(guard, req({ adminCheck: scoped([T_A]) }))).statusCode).toBe(400);
  });

  it("refuse sans adminCheck (garde mal montée, fermé par défaut)", async () => {
    const out = await run(requireTournamentScope(tournamentFrom.param("id")), req({ params: { id: T_A } }));
    expect(out.statusCode).toBe(403);
  });
});

describe("getAuthenticatedGuildId : fermé par défaut pour le niveau TOURNAMENT (SEC-21)", () => {
  it("renvoie null pour un TO de tournoi tant qu'aucune portée n'a été vérifiée", () => {
    expect(getAuthenticatedGuildId(req({ adminCheck: scoped([T_A]) }))).toBeNull();
    expect(getAuthenticatedGuildId(req({ adminCheck: server }))).toBe(GUILD);
    expect(getAuthenticatedGuildId(req())).toBeNull();
  });

  it("un accès TOURNAMENT vide n'ouvre rien", async () => {
    const empty: GuildAccess = { level: "TOURNAMENT", tournamentIds: [] };
    const q = req<{ id: string }>({ adminCheck: { discordId: "u1", guildId: GUILD, access: empty }, params: { id: T_A } });
    expect((await run(requireTournamentScope(tournamentFrom.param("id")), q)).statusCode).toBe(403);
  });
});
