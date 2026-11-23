import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

process.env.BOT_API_SECRET = "s3cret";

import { supabase } from "../lib/supabase";
import {
  authMiddleware,
  requireGuildAdmin,
  requireGuildAction,
  guildPermissionsHandler,
} from "../middleware/auth";
import {
  clearMemberAccessCache,
  invalidateGuildAccess,
  invalidateMemberAccess,
} from "../services/MemberAccessService";

function res() {
  const r = { statusCode: 200, body: undefined as unknown };
  const out = {
    status: (code: number) => ((r.statusCode = code), out),
    json: (body: unknown) => ((r.body = body), out),
  };
  return { r, out: out as unknown as Response };
}

function req(partial: Partial<Request> & { headers?: Record<string, string> }): Request {
  return { path: "/api/x", body: {}, query: {}, headers: {}, ...partial } as unknown as Request;
}

function settings(toRoleId: string | null, error: { message: string } | null = null) {
  vi.mocked(supabase.from).mockImplementation((() => {
    // Aucun tournoi n'a de rôle TO ici : l'accès de niveau TOURNAMENT est couvert par tournamentAccess.test.ts.
    const tournaments = { data: [], error: null };
    const b = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      not: () => b,
      maybeSingle: () =>
        Promise.resolve({
          data: error ? null : { config: { to_role_id: toRoleId }, to_role_id: toRoleId },
          error,
        }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(tournaments).then(resolve),
    };
    return b;
  }) as unknown as typeof supabase.from);
}

interface FakeMember {
  roles?: string[];
  admin?: boolean;
  manageGuild?: boolean;
}

/** Faux client Discord : `member` reste mutable pour simuler un rôle attribué ou retiré entre deux appels. */
function discord(member: FakeMember | null, ownerId = "owner", botInGuild = true) {
  const guild = {
    ownerId,
    members: {
      fetch: () =>
        member
          ? Promise.resolve({
              permissions: {
                has: (flag: bigint) => (flag === 8n && !!member.admin) || (flag === 32n && !!member.manageGuild),
              },
              roles: { cache: { has: (id: string) => (member.roles ?? []).includes(id) } },
            })
          : Promise.reject(new Error("Unknown Member")),
    },
  };
  return {
    guilds: { fetch: () => (botInGuild ? Promise.resolve(guild) : Promise.reject(new Error("Unknown Guild"))) },
  };
}

async function run(mw: (q: Request, s: Response, n: NextFunction) => unknown, q: Request) {
  const { r, out } = res();
  const next = vi.fn();
  await mw(q, out, next);
  return { ...r, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberAccessCache();
});

describe("authMiddleware", () => {
  it("SEC-02: refuse une requête sans Authorization", async () => {
    const out = await run(authMiddleware, req({}));
    expect(out.statusCode).toBe(401);
    expect(out.next).not.toHaveBeenCalled();
  });

  it("SEC-02: refuse tout jeton autre que BOT_API_SECRET (y compris un ancien JWT utilisateur)", async () => {
    const out = await run(authMiddleware, req({ headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" } }));
    expect(out.statusCode).toBe(401);
  });

  it("SEC-02: laisse passer le secret partagé", async () => {
    const out = await run(authMiddleware, req({ headers: { authorization: "Bearer s3cret" } }));
    expect(out.next).toHaveBeenCalled();
  });
});

describe("requireGuildAdmin", () => {
  const withUser = (guildId = "g1") => req({ headers: { "x-discord-user-id": "u1", "x-guild-id": guildId } });

  it("SEC-11: un TO sans permission Administrateur est autorisé", async () => {
    settings("to");
    const q = withUser();
    const out = await run(requireGuildAdmin(discord({ roles: ["to"] })), q);
    expect(out.next).toHaveBeenCalled();
    expect(q.adminCheck).toEqual({ discordId: "u1", guildId: "g1", access: { level: "SERVER", reason: "TO_ROLE" } });
  });

  it("SEC-04: un membre sans droit reçoit 403 NO_RIGHTS", async () => {
    settings("to");
    const out = await run(requireGuildAdmin(discord({ roles: [] })), withUser());
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ code: "NO_RIGHTS" });
    expect(out.next).not.toHaveBeenCalled();
  });

  it("SEC-04: un utilisateur absent du serveur reçoit 403 NOT_A_MEMBER", async () => {
    settings("to");
    const out = await run(requireGuildAdmin(discord(null)), withUser());
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("SEC-04: sans identité Discord ➜ 401 NOT_LOGGED_IN", async () => {
    const out = await run(requireGuildAdmin(discord({ admin: true })), req({ headers: { "x-guild-id": "g1" } }));
    expect(out.statusCode).toBe(401);
    expect(out.body).toMatchObject({ code: "NOT_LOGGED_IN" });
  });

  it("SEC-04: bot absent du serveur ➜ 404 BOT_NOT_IN_GUILD", async () => {
    settings("to");
    const out = await run(requireGuildAdmin(discord({ admin: true }, "owner", false)), withUser());
    expect(out.statusCode).toBe(404);
    expect(out.body).toMatchObject({ code: "BOT_NOT_IN_GUILD" });
  });

  it("SEC-04: une panne Supabase sur le rôle TO renvoie 503 CHECK_FAILED sans mettre le refus en cache", async () => {
    settings(null, { message: "down" });
    const first = await run(requireGuildAdmin(discord({ roles: ["to"] })), withUser());
    expect(first.statusCode).toBe(503);
    expect(first.body).toMatchObject({ code: "CHECK_FAILED" });

    settings("to");
    const second = await run(requireGuildAdmin(discord({ roles: ["to"] })), withUser());
    expect(second.next).toHaveBeenCalled();
  });
});

describe("SEC-05: invalidation du cache de permissions", () => {
  const withUser = () => req({ headers: { "x-discord-user-id": "u1", "x-guild-id": "g1" } });

  it("un TO tout juste nommé n'attend pas 30 s : guildMemberUpdate invalide son refus en cache", async () => {
    settings("to");
    const member: FakeMember = { roles: [] };
    const guard = requireGuildAdmin(discord(member));
    expect((await run(guard, withUser())).statusCode).toBe(403);

    member.roles = ["to"];
    expect((await run(guard, withUser())).statusCode).toBe(403); // refus encore en cache

    invalidateMemberAccess("g1", "u1");
    expect((await run(guard, withUser())).next).toHaveBeenCalled();
  });

  it("un TO déchu perd l'accès dès l'invalidation du serveur (roleUpdate, changement de to_role_id)", async () => {
    settings("to");
    const member: FakeMember = { roles: ["to"] };
    const guard = requireGuildAdmin(discord(member));
    expect((await run(guard, withUser())).next).toHaveBeenCalled();

    member.roles = [];
    invalidateGuildAccess("g1");
    expect((await run(guard, withUser())).statusCode).toBe(403);
  });

  it("l'invalidation d'un serveur ne touche pas le cache des autres serveurs", async () => {
    settings("to");
    const member: FakeMember = { roles: ["to"] };
    const guard = requireGuildAdmin(discord(member));
    const inG2 = req({ headers: { "x-discord-user-id": "u1", "x-guild-id": "g2" } });
    expect((await run(guard, inG2)).next).toHaveBeenCalled();

    member.roles = [];
    invalidateGuildAccess("g1");
    expect((await run(guard, inG2)).next).toHaveBeenCalled(); // g2 toujours servi par le cache
  });
});

describe("SEC-16: requireGuildAction (paramètres du serveur)", () => {
  const settingsGuard = requireGuildAction("MANAGE_SERVER_SETTINGS");
  const withAccess = (reason: "SERVER_OWNER" | "ADMINISTRATOR" | "MANAGE_GUILD" | "TO_ROLE") => {
    const q = req({});
    q.adminCheck = { discordId: "u1", guildId: "g1", access: { level: "SERVER", reason } };
    return q;
  };

  it("refuse le rôle TO avec 403 SERVER_SETTINGS_RESERVED (il ne décide pas qui est TO)", async () => {
    const out = await run(settingsGuard, withAccess("TO_ROLE"));
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ code: "SERVER_SETTINGS_RESERVED" });
    expect(out.next).not.toHaveBeenCalled();
  });

  it.each(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD"] as const)("laisse passer %s", async (reason) => {
    expect((await run(settingsGuard, withAccess(reason))).next).toHaveBeenCalled();
  });

  it("refuse si requireGuildAdmin n'a pas tourné avant (fermé par défaut)", async () => {
    const out = await run(settingsGuard, req({}));
    expect(out.statusCode).toBe(403);
    expect(out.next).not.toHaveBeenCalled();
  });

  it("de bout en bout : un membre Gérer le serveur passe, un TO est refusé", async () => {
    settings("to");
    const manager = req({ headers: { "x-discord-user-id": "u1", "x-guild-id": "g1" } });
    await run(requireGuildAdmin(discord({ manageGuild: true })), manager);
    expect((await run(settingsGuard, manager)).next).toHaveBeenCalled();

    clearMemberAccessCache();
    const to = req({ headers: { "x-discord-user-id": "u1", "x-guild-id": "g1" } });
    await run(requireGuildAdmin(discord({ roles: ["to"] })), to);
    expect((await run(settingsGuard, to)).statusCode).toBe(403);
  });
});

describe("SEC-11: /api/discord/permissions partage la décision de requireGuildAdmin", () => {
  const permQuery = (query: Record<string, string>) => req({ query });

  it("renvoie l'accès et son niveau pour un TO", async () => {
    settings("to");
    const out = await run(guildPermissionsHandler(discord({ roles: ["to"] })), permQuery({ guildId: "g1", userId: "u1" }));
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ hasPermission: true, access: { level: "SERVER", reason: "TO_ROLE" } });
  });

  it("renvoie le motif du refus (NO_RIGHTS, NOT_A_MEMBER, BOT_NOT_IN_GUILD)", async () => {
    settings("to");
    const noRights = await run(guildPermissionsHandler(discord({ roles: [] })), permQuery({ guildId: "g1", userId: "u1" }));
    expect(noRights.body).toEqual({ hasPermission: false, reason: "NO_RIGHTS" });

    clearMemberAccessCache();
    const notMember = await run(guildPermissionsHandler(discord(null)), permQuery({ guildId: "g1", userId: "u1" }));
    expect(notMember.body).toEqual({ hasPermission: false, reason: "NOT_A_MEMBER" });

    const noBot = await run(
      guildPermissionsHandler(discord({ admin: true }, "owner", false)),
      permQuery({ guildId: "g9", userId: "u1" }),
    );
    expect(noBot.body).toEqual({ hasPermission: false, reason: "BOT_NOT_IN_GUILD" });
  });

  it("une panne de vérification renvoie 503, jamais un accès", async () => {
    settings(null, { message: "down" });
    const out = await run(guildPermissionsHandler(discord({ roles: ["to"] })), permQuery({ guildId: "g1", userId: "u1" }));
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ code: "CHECK_FAILED" });
  });

  it("le panel (web) et les actions (bot) voient le même état : même cache, même invalidation", async () => {
    settings("to");
    const member: FakeMember = { roles: [] };
    const client = discord(member);
    const guard = requireGuildAdmin(client);
    const action = req({ headers: { "x-discord-user-id": "u1", "x-guild-id": "g1" } });
    expect((await run(guard, action)).statusCode).toBe(403);

    member.roles = ["to"];
    invalidateMemberAccess("g1", "u1");
    const panel = await run(guildPermissionsHandler(client), permQuery({ guildId: "g1", userId: "u1" }));
    expect(panel.body).toMatchObject({ hasPermission: true });
    expect((await run(guard, action)).next).toHaveBeenCalled();
  });

  it("refuse une requête incomplète (400)", async () => {
    const out = await run(guildPermissionsHandler(discord({ admin: true })), permQuery({ guildId: "g1" }));
    expect(out.statusCode).toBe(400);
  });
});
