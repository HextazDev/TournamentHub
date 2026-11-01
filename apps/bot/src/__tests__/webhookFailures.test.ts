import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "express";
import type { Client } from "discord.js";
const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { WebhookRolesService } from "../services/WebhookRolesService";
import { authMiddleware } from "../middleware/auth";
import { createWebhookRouter } from "../routes/WebhookRouter";
import { callRoute } from "./helpers/route";

const record = { name: "Team", tournament_id: "t", captain_discord_id: "u", is_checked_in: true };
const tournament = { guild_id: "g", discord_captain_role_id: "r" };
const originalBotSecret = process.env.BOT_API_SECRET;
const originalWebhookSecret = process.env.WEBHOOK_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: tournament, error: null }) }) }) });
});
afterEach(() => {
  if (originalBotSecret === undefined) delete process.env.BOT_API_SECRET;
  else process.env.BOT_API_SECRET = originalBotSecret;
  if (originalWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = originalWebhookSecret;
});
function setup(fail: "nickname" | "role" | "none") {
  const member = {
    manageable: true, nickname: null, user: { tag: "test", displayName: "old" },
    setNickname: vi.fn().mockImplementation(async () => { if (fail === "nickname") throw Error("denied"); }),
    roles: { cache: { has: () => false }, add: vi.fn().mockImplementation(async () => { if (fail === "role") throw Error("denied"); }) },
  };
  const role = { id: "r", name: "Captain" };
  const guild = { name: "test", members: { fetch: async () => member }, roles: { cache: { get: () => role } } };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  return { service: new WebhookRolesService(client), client, member };
}
describe("webhook Discord operation results", () => {
  it.each(["nickname", "role"] as const)("returns failure when %s update fails", async (failure) => {
    const { service } = setup(failure);
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(false);
  });
  it("reports success only after nickname and role updates complete", async () => {
    const { service, member } = setup("none");
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(true);
    expect(member.setNickname).toHaveBeenCalledOnce();
    expect(member.roles.add).toHaveBeenCalledOnce();
  });
  it("reports failure when the configured Discord role is missing", async () => {
    const member = { manageable: true, nickname: "Team", user: { tag: "test", displayName: "Team" }, roles: { cache: { has: () => false } } };
    const guild = { name: "test", members: { fetch: async () => member }, roles: { cache: { get: () => undefined } } };
    const service = new WebhookRolesService({ guilds: { fetch: async () => guild } } as unknown as Client);
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(false);
  });
});

describe("OPS-05: /api/webhook/team-update HTTP contract", () => {
  function mountProtectedWebhook(client: Client) {
    const api = Router();
    api.use("/api", authMiddleware, createWebhookRouter(client));
    return api;
  }

  it("rejects unauthenticated calls (missing Bearer token or missing/invalid x-webhook-secret)", async () => {
    process.env.BOT_API_SECRET = "bot-secret-32-chars-minimum-value";
    process.env.WEBHOOK_SECRET = "webhook-secret-value";
    const { client, member } = setup("none");
    const router = mountProtectedWebhook(client);

    const noBearer = await callRoute(router, {
      method: "POST",
      path: "/api/webhook/team-update",
      headers: { "x-webhook-secret": "webhook-secret-value" },
      body: { type: "UPDATE", table: "teams", record },
    });
    expect(noBearer.status).toBe(401);

    const badWebhookSecret = await callRoute(router, {
      method: "POST",
      path: "/api/webhook/team-update",
      headers: {
        Authorization: "Bearer bot-secret-32-chars-minimum-value",
        "x-webhook-secret": "wrong-secret",
      },
      body: { type: "UPDATE", table: "teams", record },
    });
    expect(badWebhookSecret.status).toBe(401);

    const querySecretOnly = await callRoute(router, {
      method: "POST",
      path: "/api/webhook/team-update?secret=webhook-secret-value",
      headers: { Authorization: "Bearer bot-secret-32-chars-minimum-value" },
      body: { type: "UPDATE", table: "teams", record },
    });
    expect(querySecretOnly.status).toBe(401);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("synchronizes roles and returns 200 when Bearer and x-webhook-secret headers are valid", async () => {
    process.env.BOT_API_SECRET = "bot-secret-32-chars-minimum-value";
    process.env.WEBHOOK_SECRET = "webhook-secret-value";
    const { client, member } = setup("none");
    const router = mountProtectedWebhook(client);

    const ok = await callRoute(router, {
      method: "POST",
      path: "/api/webhook/team-update",
      headers: {
        Authorization: "Bearer bot-secret-32-chars-minimum-value",
        "x-webhook-secret": "webhook-secret-value",
      },
      body: { type: "UPDATE", table: "teams", record },
    });
    expect(ok).toEqual({ status: 200, body: { received: true } });
    expect(member.setNickname).toHaveBeenCalledOnce();
    expect(member.roles.add).toHaveBeenCalledOnce();
  });
});
