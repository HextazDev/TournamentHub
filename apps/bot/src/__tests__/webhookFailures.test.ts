import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { WebhookRolesService } from "../services/WebhookRolesService";

const record = { name: "Team", tournament_id: "t", captain_discord_id: "u", is_checked_in: true };
const tournament = { guild_id: "g", discord_captain_role_id: "r" };
beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: tournament, error: null }) }) }) });
});
function setup(fail: "nickname" | "role" | "none") {
  const member = {
    manageable: true, nickname: null, user: { tag: "test", displayName: "old" },
    setNickname: vi.fn().mockImplementation(async () => { if (fail === "nickname") throw Error("denied"); }),
    roles: { cache: { has: () => false }, add: vi.fn().mockImplementation(async () => { if (fail === "role") throw Error("denied"); }) },
  };
  const role = { id: "r", name: "Captain" };
  const guild = { name: "test", members: { fetch: async () => member }, roles: { cache: { get: () => role } } };
  return { service: new WebhookRolesService({ guilds: { fetch: async () => guild } } as unknown as Client), member };
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
