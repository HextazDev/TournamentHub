import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Client, Guild, GuildMember, Role, TextChannel } from "discord.js";

const db = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../utils/tenant", () => ({
  resolveOrganization: vi.fn(),
}));

import { ArchiveService } from "../services/ArchiveService";
import { resolveOrganization } from "../utils/tenant";

function mockOrg(config: { captain_role_id?: string | null; checkin_channel_id?: string | null } = {}) {
  vi.mocked(resolveOrganization).mockResolvedValue({
    id: "org-1",
    slug: "org-1",
    name: "Org 1",
    language: "fr",
    discordGuildId: "guild-123",
    discordEnabled: true,
    discordConfig: config,
  });
}

describe("ArchiveService.backgroundDiscordCleanup (DISC-05 / LIFE-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ne déclenche aucun appel Discord si aucun tournoi n'a été archivé", async () => {
    const fetchGuild = vi.fn();
    const client = { guilds: { fetch: fetchGuild } } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, "guild-1", []);

    expect(fetchGuild).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("épargne les capitaines des tournois non archivés et nettoie uniquement les capitaines du tournoi archivé", async () => {
    const GUILD = "guild-1";
    const CAPTAIN_ROLE_ID = "role-captain";

    mockOrg({ captain_role_id: CAPTAIN_ROLE_ID, checkin_channel_id: null });
    // Supabase simulation:
    // non-archived tournaments: [ { id: "t-active", discord_captain_role_id: CAPTAIN_ROLE_ID } ]
    // active teams: [ { captain_discord_id: "user-active-captain" } ]
    db.from.mockImplementation((table: string) => {
      if (table === "tournaments") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({
                data: [{ id: "t-active", discord_captain_role_id: CAPTAIN_ROLE_ID, discord_checkin_channel_id: null }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "teams") {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [{ captain_discord_id: "user-active-captain" }],
              error: null,
            }),
          }),
        };
      }
      return {};
    });

    // Discord mock setup:
    const removeRoleMock = vi.fn();

    const memberArchived = {
      id: "user-archived-captain",
      user: { tag: "ArchivedCap#0001" },
      roles: { remove: removeRoleMock },
    } as unknown as GuildMember;

    const memberActive = {
      id: "user-active-captain",
      user: { tag: "ActiveCap#0002" },
      roles: { remove: removeRoleMock },
    } as unknown as GuildMember;

    const role = {
      id: CAPTAIN_ROLE_ID,
      members: new Map([
        ["user-archived-captain", memberArchived],
        ["user-active-captain", memberActive],
      ]),
    } as unknown as Role;

    const guild = {
      name: "Test Guild",
      roles: { fetch: vi.fn().mockResolvedValue(role) },
      members: { fetch: vi.fn().mockResolvedValue(new Map()) },
      channels: { fetch: vi.fn().mockResolvedValue(null) },
    } as unknown as Guild;

    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, GUILD, [
      { id: "t-archived", discord_captain_role_id: CAPTAIN_ROLE_ID, discord_checkin_channel_id: null },
    ]);

    // memberArchived should lose the role
    expect(removeRoleMock).toHaveBeenCalledWith(role, expect.any(String));
    // memberActive MUST NOT lose the role!
    // Since removeRoleMock is attached to both member mocks, verify call counts and targets:
    expect(removeRoleMock).toHaveBeenCalledTimes(1);
  });

  it("ne verrouille pas le salon de check-in si un tournoi actif utilise encore ce salon", async () => {
    const GUILD = "guild-1";
    const SHARED_CHANNEL_ID = "chan-shared";

    mockOrg({ captain_role_id: null, checkin_channel_id: SHARED_CHANNEL_ID });
    db.from.mockImplementation((table: string) => {
      if (table === "tournaments") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({
                data: [{ id: "t-active", discord_captain_role_id: null, discord_checkin_channel_id: SHARED_CHANNEL_ID }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "teams") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      return {};
    });

    const editPermissionsMock = vi.fn();
    const textChannel = {
      name: "check-in",
      isTextBased: () => true,
      isThread: () => false,
      permissionOverwrites: { edit: editPermissionsMock },
    } as unknown as TextChannel;

    const guild = {
      name: "Test Guild",
      roles: {
        everyone: { id: "everyone" },
        fetch: vi.fn().mockResolvedValue(null),
      },
      members: { fetch: vi.fn().mockResolvedValue(new Map()) },
      channels: { fetch: vi.fn().mockResolvedValue(textChannel) },
    } as unknown as Guild;

    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, GUILD, [
      { id: "t-archived", discord_captain_role_id: null, discord_checkin_channel_id: SHARED_CHANNEL_ID },
    ]);

    // Channel is shared with active tournament, so it MUST NOT be edited/locked
    expect(editPermissionsMock).not.toHaveBeenCalled();
  });

  it("verrouille le salon de check-in du tournoi archivé si aucun tournoi actif ne l'utilise", async () => {
    const GUILD = "guild-1";
    const ARCHIVED_CHANNEL_ID = "chan-archived";
    const ACTIVE_CHANNEL_ID = "chan-active";

    mockOrg({ captain_role_id: null, checkin_channel_id: null });
    db.from.mockImplementation((table: string) => {
      if (table === "tournaments") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({
                data: [{ id: "t-active", discord_captain_role_id: null, discord_checkin_channel_id: ACTIVE_CHANNEL_ID }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "teams") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      return {};
    });

    const editPermissionsMock = vi.fn();
    const textChannel = {
      id: ARCHIVED_CHANNEL_ID,
      name: "check-in-old",
      isTextBased: () => true,
      isThread: () => false,
      permissionOverwrites: { edit: editPermissionsMock },
    } as unknown as TextChannel;

    const guild = {
      name: "Test Guild",
      roles: {
        everyone: { id: "everyone" },
        fetch: vi.fn().mockResolvedValue(null),
      },
      members: { fetch: vi.fn().mockResolvedValue(new Map()) },
      channels: {
        fetch: vi.fn().mockImplementation((id: string) => {
          if (id === ARCHIVED_CHANNEL_ID) return Promise.resolve(textChannel);
          return Promise.resolve(null);
        }),
      },
    } as unknown as Guild;

    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, GUILD, [
      { id: "t-archived", discord_captain_role_id: null, discord_checkin_channel_id: ARCHIVED_CHANNEL_ID },
    ]);

    expect(editPermissionsMock).toHaveBeenCalledWith(guild.roles.everyone, {
      SendMessages: false,
    }, { reason: "Archivage du Tournoi" });
  });

  it("fail-closed : interrompt le nettoyage si la requête des tournois non archivés échoue", async () => {
    db.from.mockImplementation((table: string) => {
      if (table === "tournaments") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({ data: null, error: new Error("DB Error") }),
            }),
          }),
        };
      }
      return {};
    });

    const fetchRoleMock = vi.fn();
    const guild = {
      name: "Test Guild",
      roles: { fetch: fetchRoleMock },
      channels: { fetch: vi.fn() },
    } as unknown as Guild;

    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, "guild-1", [
      { id: "t-archived", discord_captain_role_id: "role-1", discord_checkin_channel_id: null },
    ]);

    expect(fetchRoleMock).not.toHaveBeenCalled();
  });

  it("fail-closed : interrompt le nettoyage si la requête des équipes actives échoue", async () => {
    mockOrg();
    db.from.mockImplementation((table: string) => {
      if (table === "tournaments") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({
                data: [{ id: "t-active", discord_captain_role_id: null, discord_checkin_channel_id: null }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "teams") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: null, error: new Error("DB teams error") }),
          }),
        };
      }
      return {};
    });

    const fetchRoleMock = vi.fn();
    const guild = {
      name: "Test Guild",
      roles: { fetch: fetchRoleMock },
      channels: { fetch: vi.fn() },
    } as unknown as Guild;

    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

    await ArchiveService.backgroundDiscordCleanup(client, "guild-1", [
      { id: "t-archived", discord_captain_role_id: "role-1", discord_checkin_channel_id: null },
    ]);

    expect(fetchRoleMock).not.toHaveBeenCalled();
  });
});
