import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { ChannelAccessService } from "../services/ChannelAccessService";

function makePerms(allowedBits: bigint[]) {
  const mask = allowedBits.reduce((acc, bit) => acc | bit, 0n);
  return {
    has: (perm: bigint | bigint[]) => {
      if (Array.isArray(perm)) {
        return perm.every((p) => (mask & p) === p);
      }
      return (mask & perm) === perm;
    },
  };
}

function fakeGuild(options: {
  ownerId?: string;
  memberPerms?: Record<string, bigint[]>;
  botPerms?: Record<string, bigint[]>;
  memberIsAdmin?: boolean;
}) {
  const memberPerms = options.memberPerms ?? {};
  const botPerms = options.botPerms ?? {};
  const ownerId = options.ownerId ?? "owner-123";

  const member = {
    id: "member-to",
    permissions: makePerms(options.memberIsAdmin ? [PermissionFlagsBits.Administrator] : []),
  };

  const botMember = {
    id: "bot-id",
    permissions: makePerms([]),
  };

  const channelsMap = new Map<string, any>();

  const addChannel = (id: string, name: string, isText: boolean) => {
    const ch = {
      id,
      name,
      guild: { ownerId },
      isTextBased: () => isText,
      permissionsFor: vi.fn((target: any) => {
        if (!target) return null;
        if (target.id === member.id) {
          if (options.memberIsAdmin || member.id === ownerId) {
            return makePerms([PermissionFlagsBits.Administrator, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
          }
          const bits = memberPerms[id] ?? [];
          return makePerms(bits);
        }
        if (target.id === botMember.id) {
          const bits = botPerms[id] ?? [];
          return makePerms(bits);
        }
        return null;
      }),
    };
    channelsMap.set(id, ch);
    return ch;
  };

  // Channel 1: public (both can view and bot can send)
  addChannel("chan-public", "general", true);
  // Channel 2: staff private (bot can view+send, member cannot view)
  addChannel("chan-private", "staff-only", true);
  // Channel 3: read-only announcement (both can view, but bot cannot send)
  addChannel("chan-readonly", "announcements-locked", true);
  // Channel 4: voice channel (not text based)
  addChannel("chan-voice", "Voice", false);

  const fetchChannels = vi.fn(() => Promise.resolve(channelsMap));
  const fetchMember = vi.fn((id: string) => {
    if (id === member.id) return Promise.resolve(member);
    if (id === botMember.id) return Promise.resolve(botMember);
    return Promise.reject(new Error("Unknown Member"));
  });

  const guild = {
    id: "guild-1",
    ownerId,
    channels: {
      cache: channelsMap,
      fetch: fetchChannels,
    },
    members: {
      me: botMember,
      fetch: fetchMember,
      fetchMe: vi.fn(() => Promise.resolve(botMember)),
    },
  };

  return { guild, member, botMember, channelsMap, fetchChannels, fetchMember };
}

describe("ChannelAccessService", () => {
  it("valide l'accès si le membre peut voir le salon et le bot peut voir et envoyer des messages", async () => {
    const setup = fakeGuild({
      memberPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel],
        "chan-private": [],
      },
      botPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        "chan-private": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    });

    const client = {
      guilds: {
        fetch: vi.fn(() => Promise.resolve(setup.guild as any)),
      },
      user: { id: "bot-id" },
    };

    const res = await ChannelAccessService.validateChannelAccess({
      client: client as any,
      guildId: "guild-1",
      discordId: "member-to",
      channelIds: ["chan-public"],
    });

    expect(res).toEqual({ ok: true });
    expect(setup.fetchChannels).toHaveBeenCalled();
  });

  it("refuse avec CHANNEL_NOT_ACCESSIBLE si le membre ne peut pas voir le salon (salon privé)", async () => {
    const setup = fakeGuild({
      memberPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel],
        "chan-private": [], // Member cannot view
      },
      botPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        "chan-private": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    });

    const client = {
      guilds: {
        fetch: vi.fn(() => Promise.resolve(setup.guild as any)),
      },
      user: { id: "bot-id" },
    };

    const res = await ChannelAccessService.validateChannelAccess({
      client: client as any,
      guildId: "guild-1",
      discordId: "member-to",
      channelIds: ["chan-private"],
    });

    expect(res).toEqual({
      ok: false,
      code: "CHANNEL_NOT_ACCESSIBLE",
      error: expect.stringContaining("chan-private"),
    });
  });

  it("refuse avec CHANNEL_NOT_ACCESSIBLE si le bot ne peut pas envoyer de messages", async () => {
    const setup = fakeGuild({
      memberPerms: {
        "chan-readonly": [PermissionFlagsBits.ViewChannel],
      },
      botPerms: {
        "chan-readonly": [PermissionFlagsBits.ViewChannel], // Missing SendMessages
      },
    });

    const client = {
      guilds: {
        fetch: vi.fn(() => Promise.resolve(setup.guild as any)),
      },
      user: { id: "bot-id" },
    };

    const res = await ChannelAccessService.validateChannelAccess({
      client: client as any,
      guildId: "guild-1",
      discordId: "member-to",
      channelIds: ["chan-readonly"],
    });

    expect(res).toEqual({
      ok: false,
      code: "CHANNEL_NOT_ACCESSIBLE",
      error: expect.stringContaining("chan-readonly"),
    });
  });

  it("refuse si le salon n'est pas textuel", async () => {
    const setup = fakeGuild({
      memberPerms: {
        "chan-voice": [PermissionFlagsBits.ViewChannel],
      },
      botPerms: {
        "chan-voice": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    });

    const client = {
      guilds: {
        fetch: vi.fn(() => Promise.resolve(setup.guild as any)),
      },
      user: { id: "bot-id" },
    };

    const res = await ChannelAccessService.validateChannelAccess({
      client: client as any,
      guildId: "guild-1",
      discordId: "member-to",
      channelIds: ["chan-voice"],
    });

    expect(res).toEqual({
      ok: false,
      code: "CHANNEL_NOT_ACCESSIBLE",
      error: expect.stringContaining("chan-voice"),
    });
  });

  it("autorise tous les salons pour un Administrateur ou Propriétaire tant que le bot peut y poster", async () => {
    const setup = fakeGuild({
      memberIsAdmin: true,
      botPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        "chan-private": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    });

    const client = {
      guilds: {
        fetch: vi.fn(() => Promise.resolve(setup.guild as any)),
      },
      user: { id: "bot-id" },
    };

    const res = await ChannelAccessService.validateChannelAccess({
      client: client as any,
      guildId: "guild-1",
      discordId: "member-to",
      channelIds: ["chan-private", "chan-public"],
    });

    expect(res).toEqual({ ok: true });
  });

  it("renvoie la liste filtrée et triée des salons visibles pour fetchAccessibleChannels", async () => {
    const setup = fakeGuild({
      memberPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel],
        "chan-private": [],
        "chan-readonly": [PermissionFlagsBits.ViewChannel],
      },
      botPerms: {
        "chan-public": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        "chan-private": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        "chan-readonly": [PermissionFlagsBits.ViewChannel], // bot cannot send
      },
    });

    const channels = await ChannelAccessService.fetchAccessibleChannels(setup.guild as any, setup.member as any);

    // Only chan-public meets all conditions
    expect(channels).toEqual([
      { id: "chan-public", name: "general" },
    ]);
  });
});
