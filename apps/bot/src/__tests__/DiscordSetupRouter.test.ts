import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../i18n", () => ({ getGuildLanguage: vi.fn(async () => "fr"), tBot: (_lang: string, key: string) => key }));

import type { AdminCheck } from "../middleware/auth";
import { autoSetupHandler, type AutoSetupClient } from "../routes/DiscordSetupRouter";
import { callRoute } from "./helpers/route";

const AUTH = "guild-auth";
const adminCheck: AdminCheck = { discordId: "owner", guildId: AUTH, access: { level: "SERVER", reason: "SERVER_OWNER" } };

const created: { guildId: string; kind: string }[] = [];
function fakeGuild(id: string) {
  return {
    id,
    roles: { create: vi.fn(async () => (created.push({ guildId: id, kind: "role" }), { id: `${id}-captain` })) },
    channels: { create: vi.fn(async () => (created.push({ guildId: id, kind: "channel" }), { id: `${id}-checkin` })) },
  };
}
const fetchGuild = vi.fn(async (id: string) => fakeGuild(id));
const client: AutoSetupClient = { guilds: { fetch: fetchGuild } };

function router(c: AutoSetupClient = client) {
  const r = express.Router();
  r.post("/auto-setup", autoSetupHandler(c));
  return r;
}

beforeEach(() => {
  created.length = 0;
  fetchGuild.mockClear();
});

describe("SEC-25: auto-setup borné au serveur authentifié", () => {
  it("corps guildId=A (authentifié) et query guildId=B ➜ seul A est touché", async () => {
    const out = await callRoute(router(), { method: "POST", path: "/auto-setup?guildId=guild-b", adminCheck, body: { guildId: AUTH } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ captain_role_id: `${AUTH}-captain`, checkin_channel_id: `${AUTH}-checkin` });
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    expect(fetchGuild).toHaveBeenCalledWith(AUTH);
    expect(created.every((c) => c.guildId === AUTH)).toBe(true);
  });

  it("un corps qui désigne un autre serveur n'est pas relu non plus", async () => {
    await callRoute(router(), { method: "POST", path: "/auto-setup", adminCheck, body: { guildId: "guild-c" } });
    expect(fetchGuild).toHaveBeenCalledWith(AUTH);
    expect(fetchGuild).not.toHaveBeenCalledWith("guild-c");
  });

  it("sans adminCheck (garde absente) ➜ 403, aucun appel Discord", async () => {
    const out = await callRoute(router(), { method: "POST", path: "/auto-setup?guildId=guild-b", body: { guildId: "guild-b" } });
    expect(out.status).toBe(403);
    expect(fetchGuild).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("bot absent ➜ 404 ; échec Discord ➜ 500 générique sans détail (SEC-19)", async () => {
    const missing: AutoSetupClient = { guilds: { fetch: async () => Promise.reject(new Error("Unknown Guild")) } };
    expect((await callRoute(router(missing), { method: "POST", path: "/auto-setup", adminCheck, body: {} })).status).toBe(404);

    const broken: AutoSetupClient = {
      guilds: {
        fetch: async (id: string) => ({ ...fakeGuild(id), roles: { create: async () => Promise.reject(new Error("Missing Permissions 50013")) } }),
      },
    };
    const out = await callRoute(router(broken), { method: "POST", path: "/auto-setup", adminCheck, body: {} });
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("50013");
  });
});
