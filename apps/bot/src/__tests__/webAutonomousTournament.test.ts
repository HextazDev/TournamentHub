import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const progressTeams = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));
vi.mock("../services/ScoreService", () => ({
  ScoreService: { progressTeams },
}));
vi.mock("../services/LeaderboardService", () => ({
  LeaderboardService: { calculateGroupStandings: vi.fn(async () => undefined) },
}));

import { playerRouter } from "../routes/PlayerRouter";
import { tournamentRouter } from "../routes/TournamentRouter";
import type { AdminCheck } from "../middleware/auth";
import { callRoute } from "./helpers/route";

const ORG_ID = "00000000-0000-0000-0000-000000000011";
const T_WEB = "00000000-0000-0000-0000-0000000000a1";
const PHASE_1 = "00000000-0000-0000-0000-0000000001a1";
const MATCH_1 = "00000000-0000-0000-0000-0000000002a1";
const TEAM_1 = "00000000-0000-0000-0000-0000000003a1";
const TEAM_2 = "00000000-0000-0000-0000-0000000003a2";

const orgOwnerCheck: AdminCheck = {
  discordId: "u-owner",
  guildId: ORG_ID,
  access: { level: "SERVER", reason: "SERVER_OWNER", nativeRole: "ORG_OWNER", source: "NATIVE" },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.current = new FakeSupabase({
    organizations: [{ id: ORG_ID, slug: "web-org", name: "Web Esports", language: "fr" }],
    organization_members: [{ organization_id: ORG_ID, user_id: "u-owner", role: "ORG_OWNER" }],
    organization_integrations: [], // Aucune intégration Discord !
    tournaments: [
      {
        id: T_WEB,
        organization_id: ORG_ID,
        guild_id: null,
        name: "Web Cup #1",
        status: "REGISTRATION",
        is_public: true,
        is_registration_open: false,
        checkin_mode: "ENABLED",
        discord_registration_channel_id: null,
      },
    ],
    phases: [{ id: PHASE_1, tournament_id: T_WEB, name: "Bracket", format: "SINGLE_ELIM", phase_order: 1 }],
    teams: [
      { id: TEAM_1, tournament_id: T_WEB, name: "Squids", captain_discord_id: "cap-1", is_checked_in: false },
      { id: TEAM_2, tournament_id: T_WEB, name: "Octos", captain_discord_id: "cap-2", is_checked_in: true },
    ],
    team_members: [],
    matches: [
      {
        id: MATCH_1,
        phase_id: PHASE_1,
        team1_id: TEAM_1,
        team2_id: TEAM_2,
        team1_score: 0,
        team2_score: 0,
        status: "PENDING",
      },
    ],
  });
});

describe("INT-02 / SEC-30 : Cycle de tournoi 100 % Web sans intégration Discord", () => {
  it("INT-02: ouvre les inscriptions, lance et clôture un tournoi d'une organisation Web sans salon ni bot Discord", async () => {
    const openRes = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/registrations`,
      adminCheck: orgOwnerCheck,
      body: { action: "open" },
    });
    expect(openRes.status).toBe(200);
    expect(db.current?.tables.tournaments?.[0]?.is_registration_open).toBe(true);

    const launchRes = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(launchRes.status).toBe(200);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("ACTIVE");

    const closeRes = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/close`,
      adminCheck: orgOwnerCheck,
    });
    expect(closeRes.status).toBe(200);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("COMPLETED");
  });

  it("INT-02: permet à un joueur de s'inscrire avec son équipe depuis le Web quand les inscriptions sont ouvertes", async () => {
    db.current!.tables.tournaments![0]!.is_registration_open = true;

    const regRes = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/register`,
      headers: { "x-discord-user-id": "cap-3" },
      body: {
        name: "Deep Cut",
        captain_ingame_name: "Shiver",
        captain_friend_code: "SW-1234-5678-9012",
        members: [{ ingame_name: "Frye", friend_code: "SW-0000-1111-2222" }],
      },
    });

    expect(regRes.status).toBe(201);
    expect(db.current?.tables.teams?.some((t) => t.name === "Deep Cut" && t.captain_discord_id === "cap-3")).toBe(true);
    expect(db.current?.tables.team_members).toHaveLength(2);
  });

  it("SEC-30 / INT-02: permet au capitaine inscrit de faire son check-in sur le Web et refuse un joueur tiers", async () => {
    const intruder = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/checkin`,
      headers: { "x-discord-user-id": "random-user" },
    });
    expect(intruder.status).toBe(403);

    const captainCheckin = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/checkin`,
      headers: { "x-discord-user-id": "cap-1" },
    });
    expect(captainCheckin.status).toBe(200);
    expect(db.current?.tables.teams?.find((t) => t.id === TEAM_1)?.is_checked_in).toBe(true);
  });

  it("SEC-30 / INT-02: seul un capitaine du match (ou un TO) peut déclarer le score d'un match sur le Web", async () => {
    const outsider = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "random-user" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(outsider.status).toBe(403);
    expect(db.current?.tables.matches?.[0]?.status).toBe("PENDING");

    const captainReport = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(captainReport.status).toBe(200);
    expect(db.current?.tables.matches?.[0]).toMatchObject({
      team1_score: 3,
      team2_score: 1,
      status: "COMPLETED",
    });
    expect(progressTeams).toHaveBeenCalledTimes(1);
  });
});
