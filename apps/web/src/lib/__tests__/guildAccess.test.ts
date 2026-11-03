import { describe, it, expect, vi } from "vitest";
import { checkGuildAdminAccess } from "../guildAccess";

const BOT = "http://bot.test";

function botReplies(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const base = { guildId: "g1", discordId: "u1", botApiUrl: BOT, botApiSecret: "s3cret" };

describe("checkGuildAdminAccess (SEC-11 / SEC-17)", () => {
  it("non connecté ➜ NOT_LOGGED_IN sans appeler le bot", async () => {
    const fetchImpl = botReplies(200, {});
    expect(await checkGuildAdminAccess({ ...base, discordId: null, fetchImpl })).toEqual({
      allowed: false,
      reason: "NOT_LOGGED_IN",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("interroge le bot avec le secret et l'identité de la session, sans cache HTTP", async () => {
    const fetchImpl = botReplies(200, { hasPermission: true, access: { level: "SERVER", reason: "TO_ROLE" } });
    const result = await checkGuildAdminAccess({ ...base, fetchImpl });
    expect(result).toEqual({ allowed: true, access: { level: "SERVER", reason: "TO_ROLE" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${BOT}/api/discord/permissions?guildId=g1&userId=u1`);
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer s3cret");
  });

  it("SEC-17 : un TO déchu dont la ligne guild_admins n'a pas été purgée est refusé (seul le bot décide)", async () => {
    const fetchImpl = botReplies(200, { hasPermission: false, reason: "NO_RIGHTS" });
    expect(await checkGuildAdminAccess({ ...base, fetchImpl })).toEqual({ allowed: false, reason: "NO_RIGHTS" });
  });

  it.each(["NOT_A_MEMBER", "BOT_NOT_IN_GUILD"] as const)("relaie le motif %s", async (reason) => {
    const fetchImpl = botReplies(200, { hasPermission: false, reason });
    expect(await checkGuildAdminAccess({ ...base, fetchImpl })).toEqual({ allowed: false, reason });
  });

  it("accepte le niveau TOURNAMENT (préparation du rôle TO de tournoi)", async () => {
    const fetchImpl = botReplies(200, { hasPermission: true, access: { level: "TOURNAMENT", tournamentIds: ["t1"] } });
    expect(await checkGuildAdminAccess({ ...base, fetchImpl })).toEqual({
      allowed: true,
      access: { level: "TOURNAMENT", tournamentIds: ["t1"] },
    });
  });

  describe("fermé par défaut : toute incertitude donne CHECK_FAILED, jamais un accès", () => {
    const denied = { allowed: false, reason: "CHECK_FAILED" };

    it("secret absent", async () => {
      const fetchImpl = botReplies(200, { hasPermission: true, access: { level: "SERVER", reason: "SERVER_OWNER" } });
      expect(await checkGuildAdminAccess({ ...base, botApiSecret: undefined, fetchImpl })).toEqual(denied);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("bot injoignable", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await checkGuildAdminAccess({ ...base, fetchImpl })).toEqual(denied);
    });

    it("vérification indisponible (503)", async () => {
      const fetchImpl = botReplies(503, { error: "Permission check temporarily unavailable", code: "CHECK_FAILED" });
      expect(await checkGuildAdminAccess({ ...base, fetchImpl })).toEqual(denied);
    });

    it("réponse inattendue (ancien format ou motif inconnu)", async () => {
      for (const body of [
        { hasPermission: true, reason: "TO_ROLE" },
        { hasPermission: true, access: { level: "SERVER", reason: "GOD_MODE" } },
        { hasPermission: false, reason: "SERVER_SETTINGS_RESERVED" },
        "<html>",
      ]) {
        expect(await checkGuildAdminAccess({ ...base, fetchImpl: botReplies(200, body) }), JSON.stringify(body)).toEqual(denied);
      }
    });
  });
});
