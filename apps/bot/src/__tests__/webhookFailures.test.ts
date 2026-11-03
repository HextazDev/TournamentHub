import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { WebhookRolesService } from "../services/WebhookRolesService";

const record = { id: "team-1", name: "Team", tournament_id: "t", captain_discord_id: "u", is_checked_in: true };
const tournament = { guild_id: "g", discord_captain_role_id: "r" };
beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: tournament, error: null }) }) }) });
});
function setup(fail: "nickname" | "role" | "none", manageable = true) {
  const member = {
    manageable, nickname: null, displayName: "old",
    setNickname: vi.fn().mockImplementation(async () => { if (fail === "nickname") throw Error("denied"); }),
    roles: {
      cache: { has: () => false },
      add: vi.fn().mockImplementation(async () => { if (fail === "role") throw Error("denied"); }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
  const role = { id: "r", name: "Captain", editable: true };
  const guild = { id: "g", members: { fetch: async () => member }, roles: { cache: { get: () => role }, fetch: async () => role } };
  return { service: new WebhookRolesService({ guilds: { fetch: async () => guild } } as unknown as Client), member };
}
describe("webhook Discord operation results", () => {
  it.each(["nickname", "role"] as const)("OPS-05: returns failure when %s update fails", async (failure) => {
    const { service } = setup(failure);
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(false);
  });
  it("reports success only after nickname and role updates complete", async () => {
    const { service, member } = setup("none");
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(true);
    expect(member.setNickname).toHaveBeenCalledOnce();
    expect(member.roles.add).toHaveBeenCalledOnce();
  });
  it("DISC-09: still adds the role when the captain cannot be renamed, but reports failure", async () => {
    const { service, member } = setup("none", false);
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(false);
    expect(member.roles.add).toHaveBeenCalledOnce();
  });
  it("DISC-09: still adds the role when the nickname is rejected", async () => {
    const { service, member } = setup("nickname");
    await service.handleTeamUpdate({ type: "UPDATE", record });
    expect(member.roles.add).toHaveBeenCalledOnce();
  });
  it("reports failure when the configured Discord role is missing", async () => {
    const member = { manageable: true, nickname: "Team", displayName: "Team", roles: { cache: { has: () => false } } };
    const guild = { id: "g", members: { fetch: async () => member }, roles: { cache: { get: () => undefined }, fetch: async () => null } };
    const service = new WebhookRolesService({ guilds: { fetch: async () => guild } } as unknown as Client);
    expect((await service.handleTeamUpdate({ type: "UPDATE", record })).success).toBe(false);
  });
  it("removes presence from old_record on DELETE (Supabase sends record: null)", async () => {
    const { service, member } = setup("none");
    const old_record = { ...record };
    const result = await service.handleTeamUpdate({ type: "DELETE", record: null, old_record });
    expect(result.success).toBe(true);
    expect(member.roles.add).not.toHaveBeenCalled();
  });
  it("rejects a malformed payload without touching Discord", async () => {
    const { service, member } = setup("none");
    expect((await service.handleTeamUpdate({ type: "UPDATE", record: { name: 42 } })).success).toBe(false);
    expect(member.roles.add).not.toHaveBeenCalled();
  });
});
