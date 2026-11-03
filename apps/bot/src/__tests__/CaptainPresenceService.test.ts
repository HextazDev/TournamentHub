import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";

const db = vi.hoisted(() => ({ from: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: log }));

import { applyPresence, hasPresenceFailure, removePresence } from "../services/CaptainPresenceService";

const team = { id: "team-1", tournament_id: "t-1", name: "Les Invincibles", captain_discord_id: "u-1" };

interface FakeOptions {
  roleId?: string | null;
  manageable?: boolean;
  nickname?: string | null;
  hasRole?: boolean;
  roleInCache?: boolean;
  roleFetchable?: boolean;
  roleEditable?: boolean;
  rejectRoleAdd?: Error;
  rejectNickname?: Error;
  memberMissing?: boolean;
}

function discordError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function setup(o: FakeOptions = {}) {
  const roleId = o.roleId === undefined ? "role-cap" : o.roleId;
  db.from.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { guild_id: "g-1", discord_captain_role_id: roleId }, error: null }),
      }),
    }),
  });
  const role = { id: "role-cap", name: "Capitaine", editable: o.roleEditable ?? true };
  const member = {
    manageable: o.manageable ?? true,
    nickname: o.nickname ?? null,
    displayName: o.nickname ?? "pseudo",
    setNickname: vi.fn(async () => {
      if (o.rejectNickname) throw o.rejectNickname;
    }),
    roles: {
      cache: { has: () => o.hasRole ?? false },
      add: vi.fn(async () => {
        if (o.rejectRoleAdd) throw o.rejectRoleAdd;
      }),
      remove: vi.fn(async () => undefined),
    },
  };
  const rolesFetch = vi.fn(async () => (o.roleFetchable ?? true ? role : null));
  const guild = {
    id: "g-1",
    members: {
      fetch: vi.fn(async () => {
        if (o.memberMissing) throw discordError(10007, "Unknown Member");
        return member;
      }),
    },
    roles: { cache: { get: () => (o.roleInCache ?? true ? role : undefined) }, fetch: rolesFetch },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } } as unknown as Client;
  return { client, member, rolesFetch };
}

beforeEach(() => vi.clearAllMocks());

describe("CaptainPresenceService.applyPresence", () => {
  it("applies nickname and role on a regular captain", async () => {
    const { client, member } = setup();
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "applied", role: "applied" });
    expect(member.setNickname).toHaveBeenCalledWith("Les Invincibles", expect.any(String));
    expect(member.roles.add).toHaveBeenCalledOnce();
    expect(hasPresenceFailure(report)).toBe(false);
  });

  it("DISC-10: fetches the role from Discord when it is missing from the cache", async () => {
    const { client, member, rolesFetch } = setup({ roleInCache: false });
    const report = await applyPresence(client, team);
    expect(rolesFetch).toHaveBeenCalledWith("role-cap");
    expect(member.roles.add).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ role: "applied" });
  });

  it("DISC-10: reports not_found when the role exists neither in cache nor on Discord", async () => {
    const { client, member } = setup({ roleInCache: false, roleFetchable: false });
    const report = await applyPresence(client, team);
    expect(report).toMatchObject({ role: "not_found" });
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(hasPresenceFailure(report)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[CaptainPresence]"), expect.objectContaining({ reason: "role_not_found" }));
  });

  it("DISC-10: reports above_bot without calling Discord when the role is above the bot", async () => {
    const { client, member } = setup({ roleEditable: false });
    const report = await applyPresence(client, team);
    expect(report).toMatchObject({ role: "above_bot" });
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: "role_above_bot" }));
  });

  it("DISC-09: still adds the role when the member cannot be renamed (owner / admin above the bot)", async () => {
    const { client, member } = setup({ manageable: false });
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "not_manageable", role: "applied" });
    expect(member.setNickname).not.toHaveBeenCalled();
    expect(member.roles.add).toHaveBeenCalledOnce();
    expect(hasPresenceFailure(report)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: "member_not_manageable" }));
  });

  it("DISC-09: still adds the role when Discord rejects the nickname", async () => {
    const { client, member } = setup({ rejectNickname: discordError(50013, "Missing Permissions") });
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "failed", role: "applied" });
    expect(member.roles.add).toHaveBeenCalledOnce();
  });

  it("reports failed with the Discord code and never logs a success when roles.add is rejected", async () => {
    const { client } = setup({ rejectRoleAdd: discordError(50013, "Missing Permissions") });
    const report = await applyPresence(client, team);
    expect(report).toMatchObject({ role: "failed" });
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: "role_add_failed", code: 50013 }));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/role added/i), expect.anything());
  });

  it("is idempotent when nickname and role are already applied", async () => {
    const { client, member } = setup({ nickname: "Les Invincibles", hasRole: true });
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "unchanged", role: "unchanged" });
    expect(member.setNickname).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("truncates the nickname to Discord's 32 characters", async () => {
    const { client, member } = setup();
    await applyPresence(client, { ...team, name: "x".repeat(40) });
    expect(member.setNickname).toHaveBeenCalledWith("x".repeat(32), expect.any(String));
  });

  it("reports not_configured (not a failure) when the tournament has no captain role", async () => {
    const { client } = setup({ roleId: null });
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "applied", role: "not_configured" });
    expect(hasPresenceFailure(report)).toBe(false);
  });

  it("skips with a warning when the captain left the server", async () => {
    const { client } = setup({ memberMissing: true });
    const report = await applyPresence(client, team);
    expect(report).toEqual({ status: "skipped", reason: "member_unavailable" });
    expect(hasPresenceFailure(report)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: "member_unavailable", code: 10007 }));
  });
});

describe("CaptainPresenceService.removePresence", () => {
  it("removes the team nickname and the role", async () => {
    const { client, member } = setup({ nickname: "Les Invincibles", hasRole: true, roleInCache: false });
    const report = await removePresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "applied", role: "applied" });
    expect(member.setNickname).toHaveBeenCalledWith(null, expect.any(String));
    expect(member.roles.remove).toHaveBeenCalledOnce();
  });

  it("keeps a nickname the captain chose themselves", async () => {
    const { client, member } = setup({ nickname: "AutrePseudo", hasRole: false });
    const report = await removePresence(client, team);
    expect(report).toEqual({ status: "done", nickname: "unchanged", role: "unchanged" });
    expect(member.setNickname).not.toHaveBeenCalled();
  });
});
