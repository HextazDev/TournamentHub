import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const presence = vi.hoisted(() => ({
  applyPresence: vi.fn(async () => ({ status: "done" as const, nickname: "applied" as const, role: "applied" as const })),
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));
vi.mock("../services/CaptainPresenceService", () => ({
  applyPresence: presence.applyPresence,
}));

import { IntegrationBus, INTEGRATION_EVENT_NAMES } from "../services/IntegrationBus";
import { discordIntegrationPlugin } from "../services/integrations/DiscordIntegrationPlugin";
import { SchedulerService } from "../services/SchedulerService";

const ORG_ID = "00000000-0000-0000-0000-000000000011";
const GUILD_ID = "111111111111111111";
const OTHER_GUILD_ID = "999999999999999999";
const T_ID = "00000000-0000-0000-0000-0000000000a1";
const PHASE_ID = "00000000-0000-0000-0000-0000000001a1";
const GROUP_ID = "00000000-0000-0000-0000-0000000001b1";
const TEAM_1 = "00000000-0000-0000-0000-0000000002a1";
const TEAM_2 = "00000000-0000-0000-0000-0000000002a2";
const MATCH_1 = "00000000-0000-0000-0000-0000000003a1";
const MATCH_GRP = "00000000-0000-0000-0000-0000000003a2";

function makeTextChannel(id: string, guildId = GUILD_ID) {
  const send = vi.fn(async (_payload: unknown) => ({ id: `sent-${id}` }));
  const edit = vi.fn(async (_payload: unknown) => undefined);
  const fetchMsg = vi.fn(async () => ({ id: "msg-checkin", edit }));
  return {
    id,
    guildId,
    isTextBased: () => true,
    send,
    messages: { fetch: fetchMsg },
    _edit: edit,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  IntegrationBus.clearPlugins();
  IntegrationBus.registerPlugin(discordIntegrationPlugin);

  db.current = new FakeSupabase({
    organizations: [{ id: ORG_ID, slug: "splat-org", name: "Splat Org", language: "fr" }],
    organization_integrations: [
      {
        id: "int-discord",
        organization_id: ORG_ID,
        provider: "DISCORD",
        external_id: GUILD_ID,
        enabled: true,
        status: "CONNECTED",
        config: {},
      },
    ],
    tournaments: [
      {
        id: T_ID,
        organization_id: ORG_ID,
        name: "Autumn Cup",
        status: "ACTIVE",
        language: "fr",
        checkin_mode: "ENABLED",
        checkin_end_at: "2026-12-01T12:00:00.000Z",
        checkin_message_id: null,
        discord_config: {
          registration_channel_id: "ch-reg",
          checkin_channel_id: "ch-checkin",
          captain_role_id: "role-cap",
        },
      },
    ],
    phases: [
      { id: PHASE_ID, tournament_id: T_ID, name: "Top 8", format: "SINGLE_ELIM", discord_channel_id: "ch-phase" },
    ],
    groups: [
      { id: GROUP_ID, phase_id: PHASE_ID, name: "A", discord_channel_id: "ch-group" },
    ],
    teams: [
      { id: TEAM_1, tournament_id: T_ID, name: "Alpha", captain_discord_id: "123456789012345678", is_checked_in: true },
      { id: TEAM_2, tournament_id: T_ID, name: "Bravo", captain_discord_id: "234567890123456789", is_checked_in: true },
    ],
    team_members: [
      { id: "m-1", team_id: TEAM_1, user_id: "123456789012345678", ingame_name: "Alice", friend_code: "SW-1111-1111-1111", is_captain: true },
      { id: "m-2", team_id: TEAM_1, user_id: null, ingame_name: "Bob", friend_code: "SW-2222-2222-2222", is_captain: false },
    ],
    matches: [
      {
        id: MATCH_1,
        phase_id: PHASE_ID,
        group_id: null,
        match_number: 4,
        team1_id: TEAM_1,
        team2_id: TEAM_2,
        team1_score: 2,
        team2_score: 1,
        status: "COMPLETED",
        discord_channel_id: null,
      },
      {
        id: MATCH_GRP,
        phase_id: PHASE_ID,
        group_id: GROUP_ID,
        match_number: 2,
        team1_id: TEAM_1,
        team2_id: TEAM_2,
        team1_score: 3,
        team2_score: 0,
        status: "FF",
        discord_channel_id: null,
      },
    ],
  });
});

describe("INT-04 (#102): parité du contrat IntegrationBus / DiscordIntegrationPlugin", () => {
  it("chaque événement déclaré dans INTEGRATION_EVENT_NAMES possède un handler sur discordIntegrationPlugin (plus de onTournamentCreated mort)", () => {
    expect(INTEGRATION_EVENT_NAMES).not.toContain("onTournamentCreated");
    for (const eventName of INTEGRATION_EVENT_NAMES) {
      expect(typeof discordIntegrationPlugin[eventName], `handler manquant pour ${eventName}`).toBe("function");
    }
  });
});

describe("INT-04 (#102): handlers DiscordIntegrationPlugin", () => {
  it("onTeamRegistered: annonce l'inscription Web dans registration_channel_id et applique la présence uniquement si checkin DISABLED", async () => {
    const regChannel = makeTextChannel("ch-reg");
    const client = { channels: { fetch: vi.fn(async (id: string) => (id === "ch-reg" ? regChannel : null)) } };

    const warnings = await IntegrationBus.emit("onTeamRegistered", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });

    expect(warnings).toEqual([]);
    expect(regChannel.send).toHaveBeenCalledTimes(1);
    expect(presence.applyPresence).not.toHaveBeenCalled();

    // Check-in désactivé ➜ présence appliquée immédiatement pour un vrai capitaine Discord
    db.current!.tables.tournaments![0]!.checkin_mode = "DISABLED";
    await IntegrationBus.emit("onTeamRegistered", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });
    expect(presence.applyPresence).toHaveBeenCalledTimes(1);
  });

  it("SEC-01: onTeamRegistered refuse de publier dans un salon appartenant à un autre serveur", async () => {
    const foreignChannel = makeTextChannel("ch-reg", OTHER_GUILD_ID);
    const client = { channels: { fetch: vi.fn(async () => foreignChannel) } };

    const warnings = await IntegrationBus.emit("onTeamRegistered", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });

    expect(warnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);
    expect(foreignChannel.send).not.toHaveBeenCalled();
  });

  it("onCheckinCompleted: applique la présence Discord sur check-in Web et ignore les capitaines synthétiques", async () => {
    const client = { channels: { fetch: vi.fn() } };
    const warnings = await IntegrationBus.emit("onCheckinCompleted", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });

    expect(warnings).toEqual([]);
    expect(presence.applyPresence).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: TEAM_1, tournament_id: T_ID, name: "Alpha", captain_discord_id: "123456789012345678" }),
    );

    vi.clearAllMocks();
    db.current!.tables.teams![0]!.captain_discord_id = "000000123456789012";
    await IntegrationBus.emit("onCheckinCompleted", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("onCheckinOpened & onCheckinClosed: SchedulerService émet sur le bus et publie/édite l'embed de check-in", async () => {
    const checkinChannel = makeTextChannel("ch-checkin");
    const client = { channels: { fetch: vi.fn(async (id: string) => (id === "ch-checkin" ? checkinChannel : null)) } };
    Reflect.set(SchedulerService, "client", client);

    await Reflect.get(SchedulerService, "handleOpenCheckin").call(SchedulerService, T_ID);
    expect(checkinChannel.send).toHaveBeenCalledTimes(1);
    expect(db.current?.tables.tournaments?.[0]?.checkin_message_id).toBe("sent-ch-checkin");

    await SchedulerService.handleCloseCheckin(T_ID);
    expect(checkinChannel._edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("DISC-18 (#102): onMatchCompleted annonce un score Web dans le salon de phase et un forfait dans le salon de groupe", async () => {
    const phaseChannel = makeTextChannel("ch-phase");
    const groupChannel = makeTextChannel("ch-group");
    const client = {
      channels: {
        fetch: vi.fn(async (id: string) => (id === "ch-phase" ? phaseChannel : id === "ch-group" ? groupChannel : null)),
      },
    };

    const webWarnings = await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: client as never,
      data: { source: "WEB_CAPTAIN", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });
    expect(webWarnings).toEqual([]);
    expect(phaseChannel.send).toHaveBeenCalledTimes(1);
    const webEmbed = (phaseChannel.send.mock.calls[0]?.[0] as { embeds: { data: { title?: string; description?: string } }[] }).embeds[0]?.data;
    expect(webEmbed?.description).toContain("Alpha");
    expect(webEmbed?.description).toContain("Bravo");
    expect(webEmbed?.description).toContain("2");
    expect(webEmbed?.description).toContain("1");

    const ffWarnings = await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_GRP,
      discordClient: client as never,
      data: { source: "TO_FORCE", status: "FF", team1_score: 3, team2_score: 0 },
    });
    expect(ffWarnings).toEqual([]);
    expect(groupChannel.send).toHaveBeenCalledTimes(1);
    const ffEmbed = (groupChannel.send.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] }).embeds[0]?.data;
    expect(ffEmbed?.title).toContain("Forfait");
  });

  it("DISC-18: onMatchCompleted n'envoie pas de doublon si source === 'DISCORD' et refuse un salon hors serveur", async () => {
    const phaseChannel = makeTextChannel("ch-phase");
    const foreignChannel = makeTextChannel("ch-phase", OTHER_GUILD_ID);
    const client = { channels: { fetch: vi.fn(async () => phaseChannel) } };

    await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: client as never,
      data: { source: "DISCORD", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });
    expect(phaseChannel.send).not.toHaveBeenCalled();

    const foreignClient = { channels: { fetch: vi.fn(async () => foreignChannel) } };
    const warnings = await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: foreignClient as never,
      data: { source: "TO_FORCE", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });
    expect(warnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);
    expect(foreignChannel.send).not.toHaveBeenCalled();
  });

  it("SEC-26: aucun handler n'est invoqué quand l'intégration Discord est désactivée", async () => {
    db.current!.tables.organization_integrations![0]!.enabled = false;
    const fetch = vi.fn();
    const client = { channels: { fetch } };

    await IntegrationBus.emit("onTeamRegistered", { organizationId: ORG_ID, tournamentId: T_ID, teamId: TEAM_1, discordClient: client as never });
    await IntegrationBus.emit("onCheckinCompleted", { organizationId: ORG_ID, tournamentId: T_ID, teamId: TEAM_1, discordClient: client as never });
    await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: client as never,
      data: { source: "WEB_CAPTAIN", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("AUD-SEC-02: refuse en fail-closed un salon sans guildId (ex. DMChannel) sur inscription, check-in et score", async () => {
    const dmChannel = {
      id: "ch-dm",
      isTextBased: () => true,
      send: vi.fn(async () => ({ id: "sent-dm" })),
      messages: { fetch: vi.fn(async () => ({ id: "msg-dm", edit: vi.fn() })) },
    };
    const client = { channels: { fetch: vi.fn(async () => dmChannel) } };

    const regWarnings = await IntegrationBus.emit("onTeamRegistered", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
    });
    expect(regWarnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);

    const openWarnings = await IntegrationBus.emit("onCheckinOpened", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      discordClient: client as never,
    });
    expect(openWarnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);

    db.current!.tables.tournaments![0]!.checkin_message_id = "msg-dm";
    const closeWarnings = await IntegrationBus.emit("onCheckinClosed", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      discordClient: client as never,
    });
    expect(closeWarnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);

    const matchWarnings = await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: client as never,
      data: { source: "WEB_CAPTAIN", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });
    expect(matchWarnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);

    expect(dmChannel.send).not.toHaveBeenCalled();
  });

  it("AUD-ARC-01: onTeamRegistered et onCheckinCompleted n'envoient aucun doublon si source === 'DISCORD' et WEB_STAFF utilise le titre arbitrage TO", async () => {
    const regChannel = makeTextChannel("ch-reg");
    const phaseChannel = makeTextChannel("ch-phase");
    const client = {
      channels: {
        fetch: vi.fn(async (id: string) => (id === "ch-reg" ? regChannel : id === "ch-phase" ? phaseChannel : null)),
      },
    };

    await IntegrationBus.emit("onTeamRegistered", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
      data: { source: "DISCORD" },
    });
    await IntegrationBus.emit("onCheckinCompleted", {
      organizationId: ORG_ID,
      tournamentId: T_ID,
      teamId: TEAM_1,
      discordClient: client as never,
      data: { source: "DISCORD" },
    });
    expect(regChannel.send).not.toHaveBeenCalled();
    expect(presence.applyPresence).not.toHaveBeenCalled();

    const staffWarnings = await IntegrationBus.emit("onMatchCompleted", {
      organizationId: ORG_ID,
      phaseId: PHASE_ID,
      matchId: MATCH_1,
      discordClient: client as never,
      data: { source: "WEB_STAFF", status: "COMPLETED", team1_score: 2, team2_score: 1 },
    });
    expect(staffWarnings).toEqual([]);
    const staffEmbed = (phaseChannel.send.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] }).embeds[0]?.data;
    expect(staffEmbed?.title).toContain("arbitré");
  });
});

