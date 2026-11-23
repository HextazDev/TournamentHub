import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../i18n", () => ({
  tBot: (_lang: string, key: string) => key,
  getGuildLanguage: async () => "fr",
  discordLocalizations: () => ({ fr: "desc", "en-US": "desc", "en-GB": "desc" }),
}));

import { execute as executeCheckin } from "../commands/admin-setup-checkin";
import { autocomplete as autocompleteTransfer, execute as executeTransfer } from "../commands/admin-transfer";

const ORG_ID = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000022";
const GUILD_ID = "111111111111111111";

function seed(discordEnabled = true) {
  db.current = new FakeSupabase({
    organizations: [
      { id: ORG_ID, slug: "splatoon-fr", name: "Splatoon FR", language: "fr" },
      { id: OTHER_ORG_ID, slug: "other-org", name: "Other Org", language: "fr" },
    ],
    organization_integrations: [
      {
        id: "int-1",
        organization_id: ORG_ID,
        provider: "DISCORD",
        external_id: GUILD_ID,
        enabled: discordEnabled,
        config: { to_role_id: "role-to" },
      },
    ],
    tournaments: [
      { id: "t-1", organization_id: ORG_ID, name: "Cup 1", created_at: "2026-01-01T00:00:00Z", checkin_message_id: null },
      { id: "t-other", organization_id: OTHER_ORG_ID, name: "Other Cup", created_at: "2026-01-02T00:00:00Z", checkin_message_id: null },
    ],
    teams: [
      { id: "team-1", tournament_id: "t-1", name: "Alpha", captain_discord_id: "old-cap" },
      { id: "team-other", tournament_id: "t-other", name: "AlphaOther", captain_discord_id: "other-cap" },
    ],
    team_members: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed(true);
});

describe("admin-setup-checkin (#101 organization_id & SEC-26)", () => {
  function checkinInteraction(options: { admin?: boolean; roles?: string[] } = {}) {
    const reply = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ id: "msg-checkin-1" }));
    const interaction = {
      isChatInputCommand: () => true,
      guildId: GUILD_ID,
      memberPermissions: {
        has: (flag: bigint) => flag === PermissionFlagsBits.Administrator && Boolean(options.admin),
      },
      member: {
        roles: { cache: { has: (id: string) => (options.roles ?? []).includes(id) } },
      },
      channel: { send },
      reply,
    } as unknown as ChatInputCommandInteraction;
    return { interaction, reply, send };
  }

  it("met à jour checkin_message_id uniquement sur le tournoi de l'organisation du serveur", async () => {
    const { interaction, reply, send } = checkinInteraction({ roles: ["role-to"] });
    await executeCheckin(interaction);

    expect(send).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({ content: "checkin.panelDeployed", ephemeral: true });
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-1")?.checkin_message_id).toBe("msg-checkin-1");
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-other")?.checkin_message_id).toBeNull();
  });

  it("SEC-26: refuse la commande même pour un administrateur si l'intégration Discord est désactivée", async () => {
    seed(false);
    const { interaction, reply, send } = checkinInteraction({ admin: true, roles: ["role-to"] });
    await executeCheckin(interaction);

    expect(send).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "checkin.noPermission", ephemeral: true });
  });
});

describe("admin-transfer (#101 organization_id & SEC-26)", () => {
  it("autocomplete filtre les équipes par organization_id du serveur et renvoie [] si Discord est désactivé", async () => {
    const respond = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      options: { getFocused: () => "Alpha" },
      respond,
    } as unknown as AutocompleteInteraction;

    await autocompleteTransfer(interaction);
    expect(respond).toHaveBeenCalledWith([{ name: "Alpha", value: "Alpha" }]);

    respond.mockClear();
    seed(false);
    await autocompleteTransfer(interaction);
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("execute refuse l'accès lorsque l'intégration Discord est désactivée (SEC-26)", async () => {
    seed(false);
    const reply = vi.fn(async () => undefined);
    const deferReply = vi.fn(async () => undefined);
    const interaction = {
      isChatInputCommand: () => true,
      guildId: GUILD_ID,
      member: { roles: { cache: { has: () => true } } },
      options: {
        getString: () => "Alpha",
        getUser: () => ({ id: "new-cap", username: "NewCap" }),
      },
      reply,
      deferReply,
    } as unknown as ChatInputCommandInteraction;

    await executeTransfer(interaction);
    expect(reply).toHaveBeenCalledWith({ content: "transfer.accessDenied", ephemeral: true });
    expect(deferReply).not.toHaveBeenCalled();
  });
});
