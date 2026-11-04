import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { AdminCheck } from "../middleware/auth";
import { discordListHandlers, type DiscordListClient } from "../routes/DiscordListRouter";
import { callRoute } from "./helpers/route";

const AUTH = "guild-auth";
const adminCheck: AdminCheck = { discordId: "to", guildId: AUTH, access: { level: "SERVER", reason: "TO_ROLE" } };

function fakeGuild(id: string) {
  const roles = new Map([[`${id}-r`, { id: `${id}-r`, name: `role-${id}`, hexColor: "#fff" }], [`${id}-every`, { id: `${id}-every`, name: "@everyone", hexColor: "#000" }]]);
  const channels = new Map([[`${id}-c`, { id: `${id}-c`, name: `chan-${id}`, isTextBased: () => true }]]);
  const members = new Map([[`${id}-m`, { user: { id: `${id}-m`, username: `user-${id}`, bot: false }, displayName: `Member ${id}` }]]);
  return {
    roles: { cache: roles },
    channels: { cache: channels },
    members: { fetch: () => Promise.resolve(members) },
  };
}

const fetchGuild = vi.fn((id: string) => Promise.resolve(fakeGuild(id)));
const client: DiscordListClient = { guilds: { fetch: fetchGuild } };

function router() {
  const handlers = discordListHandlers(client);
  const r = express.Router();
  r.get("/roles", handlers.roles);
  r.get("/channels", handlers.channels);
  r.get("/members", handlers.members);
  return r;
}

beforeEach(() => fetchGuild.mockClear());

describe("SEC-25: listes Discord bornées au serveur authentifié", () => {
  it.each(["roles", "channels", "members"])("%s : query et corps désignant d'autres serveurs sont ignorés", async (list) => {
    const out = await callRoute(router(), {
      method: "GET",
      path: `/${list}?guildId=guild-query`,
      adminCheck,
    });
    expect(out.status).toBe(200);
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    expect(fetchGuild).toHaveBeenCalledWith(AUTH);
    expect(JSON.stringify(out.body)).toContain(AUTH);
    expect(JSON.stringify(out.body)).not.toContain("guild-query");
  });

  it("le corps d'une requête ne change pas non plus le serveur lu", async () => {
    // Une requête GET ne porte pas de corps : la même liste est exposée en POST pour éprouver ce cas.
    const r = express.Router();
    r.post("/roles", discordListHandlers(client).roles);
    const out = await callRoute(r, { method: "POST", path: "/roles?guildId=guild-query", adminCheck, body: { guildId: "guild-body" } });
    expect(out.status).toBe(200);
    expect(fetchGuild).toHaveBeenCalledWith(AUTH);
    expect(fetchGuild).not.toHaveBeenCalledWith("guild-body");
  });

  it("filtre @everyone, trie et ne renvoie que les champs utiles", async () => {
    const out = await callRoute(router(), { method: "GET", path: "/roles", adminCheck });
    expect(out.body).toEqual([{ id: `${AUTH}-r`, name: `role-${AUTH}`, color: "#fff" }]);
  });

  it("sans serveur authentifié (garde absente) ➜ 403, aucun appel Discord", async () => {
    const out = await callRoute(router(), { method: "GET", path: "/channels?guildId=guild-query" });
    expect(out.status).toBe(403);
    expect(fetchGuild).not.toHaveBeenCalled();
  });

  it("bot absent du serveur ➜ 404 ; panne Discord ➜ 500 générique (SEC-19)", async () => {
    fetchGuild.mockImplementationOnce(() => Promise.reject(new Error("Unknown Guild")));
    expect((await callRoute(router(), { method: "GET", path: "/roles", adminCheck })).status).toBe(404);

    const broken = { guilds: { fetch: () => Promise.resolve({ ...fakeGuild(AUTH), members: { fetch: () => Promise.reject(new Error("secret detail")) } }) } };
    const handlers = discordListHandlers(broken);
    const r = express.Router();
    r.get("/members", handlers.members);
    const out = await callRoute(r, { method: "GET", path: "/members", adminCheck });
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("secret detail");
  });
});
