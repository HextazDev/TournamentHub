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
import { authMiddleware, requireGuildAdmin, clearPermissionCache } from "../middleware/auth";

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
    const b = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => Promise.resolve({ data: toRoleId === null && error ? null : { to_role_id: toRoleId }, error }),
    };
    return b;
  }) as unknown as typeof supabase.from);
}

function discord(member: { roles?: string[]; admin?: boolean } | null, ownerId = "owner") {
  const guild = {
    ownerId,
    members: {
      fetch: () =>
        member
          ? Promise.resolve({
              permissions: { has: (flag: bigint) => flag === 8n && !!member.admin },
              roles: { cache: { has: (id: string) => (member.roles ?? []).includes(id) } },
            })
          : Promise.reject(new Error("Unknown Member")),
    },
  };
  return { guilds: { fetch: () => Promise.resolve(guild) } };
}

async function run(mw: (q: Request, s: Response, n: NextFunction) => unknown, q: Request) {
  const { r, out } = res();
  const next = vi.fn();
  await mw(q, out, next);
  return { ...r, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
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
    expect(q.adminCheck).toEqual({ discordId: "u1", guildId: "g1", reason: "TO_ROLE" });
  });

  it("SEC-04: un membre sans droit reçoit 403", async () => {
    settings("to");
    const out = await run(requireGuildAdmin(discord({ roles: [] })), withUser());
    expect(out.statusCode).toBe(403);
    expect(out.next).not.toHaveBeenCalled();
  });

  it("SEC-04: un utilisateur absent du serveur reçoit 403", async () => {
    settings("to");
    const out = await run(requireGuildAdmin(discord(null)), withUser());
    expect(out.statusCode).toBe(403);
  });

  it("SEC-04: une panne Supabase sur le rôle TO renvoie 503 sans mettre le refus en cache", async () => {
    settings(null, { message: "down" });
    const first = await run(requireGuildAdmin(discord({ roles: ["to"] })), withUser());
    expect(first.statusCode).toBe(503);

    settings("to");
    const second = await run(requireGuildAdmin(discord({ roles: ["to"] })), withUser());
    expect(second.next).toHaveBeenCalled();
  });
});
