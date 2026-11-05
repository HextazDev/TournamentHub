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
  it("INT-02: crée un tournoi pour une organisation Web même lorsque la table server_settings est supprimée (Option 5A)", async () => {
    db.current!.tableErrors.server_settings = {
      code: "42P01",
      message: 'relation "public.server_settings" does not exist',
    };

    const createRes = await callRoute(tournamentRouter, {
      method: "POST",
      path: "/",
      adminCheck: orgOwnerCheck,
      body: {
        organization_id: ORG_ID,
        name: "Web Cup #2",
        language: "fr",
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      organization_id: ORG_ID,
      guild_id: null,
      name: "Web Cup #2",
      status: "DRAFT",
      language: "fr",
    });
  });

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

  it("SEC-30 / ARC-01: respecte la fenêtre de check-in et refuse le check-in hors fenêtre ou désactivé", async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const past = new Date(Date.now() - 3600000).toISOString();

    // 1. Fenêtre pas encore ouverte (start_at dans le futur)
    db.current!.tables.tournaments![0]!.checkin_start_at = future;
    db.current!.tables.tournaments![0]!.checkin_end_at = new Date(Date.now() + 7200000).toISOString();
    const tooEarly = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/checkin`,
      headers: { "x-discord-user-id": "cap-1" },
    });
    expect(tooEarly.status).toBe(400);
    expect((tooEarly.body as { error: string }).error).toContain("pas encore ouverte");

    // 2. Fenêtre terminée (end_at dans le passé)
    db.current!.tables.tournaments![0]!.checkin_start_at = new Date(Date.now() - 7200000).toISOString();
    db.current!.tables.tournaments![0]!.checkin_end_at = past;
    const tooLate = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/checkin`,
      headers: { "x-discord-user-id": "cap-1" },
    });
    expect(tooLate.status).toBe(400);
    expect((tooLate.body as { error: string }).error).toContain("terminée");

    // 3. Check-in désactivé
    db.current!.tables.tournaments![0]!.checkin_mode = "DISABLED";
    db.current!.tables.tournaments![0]!.checkin_start_at = null;
    db.current!.tables.tournaments![0]!.checkin_end_at = null;
    const disabledRes = await callRoute(playerRouter, {
      method: "POST",
      path: `/tournaments/${T_WEB}/checkin`,
      headers: { "x-discord-user-id": "cap-1" },
    });
    expect(disabledRes.status).toBe(400);
    expect((disabledRes.body as { error: string }).error).toContain("désactivé");

    // 4. Fenêtre ouverte ➜ succès
    db.current!.tables.tournaments![0]!.checkin_mode = "ENABLED";
    db.current!.tables.tournaments![0]!.checkin_start_at = past;
    db.current!.tables.tournaments![0]!.checkin_end_at = future;

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

  it("ARC-02: refuse de lancer un tournoi depuis un statut invalide et purge les équipes non checkées", async () => {
    // Équipe 1 non checkée, Équipe 2 checkée
    db.current!.tables.teams![0]!.is_checked_in = false;
    db.current!.tables.teams![1]!.is_checked_in = true;

    // Refuse le lancement si déjà ACTIVE
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    const invalidLaunch = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(invalidLaunch.status).toBe(400);

    // Lancement depuis REGISTRATION ➜ purge TEAM_1 non checkée et passe ACTIVE
    db.current!.tables.tournaments![0]!.status = "REGISTRATION";
    const validLaunch = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(validLaunch.status).toBe(200);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("ACTIVE");
    // TEAM_1 non checkée doit être purgée
    expect(db.current?.tables.teams?.find((t) => t.id === TEAM_1)).toBeUndefined();
    // TEAM_2 checkée doit être conservée
    expect(db.current?.tables.teams?.find((t) => t.id === TEAM_2)).toBeDefined();
  });

  it("SEC-02 / SEC-30: flux de score complet avec validation adverse, atomicité et contrôle tournoi ACTIVE", async () => {
    // 1. Refus si le tournoi n'est pas ACTIVE
    db.current!.tables.tournaments![0]!.status = "REGISTRATION";
    const notActiveRes = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(notActiveRes.status).toBe(400);
    expect((notActiveRes.body as { error: string }).error).toContain("actif");

    // Le tournoi passe ACTIVE
    db.current!.tables.tournaments![0]!.status = "ACTIVE";

    // 2. Refus pour un utilisateur tiers
    const outsider = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "random-user" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(outsider.status).toBe(403);
    expect(db.current?.tables.matches?.[0]?.status).toBe("PENDING");

    // 3. Le capitaine de Team 1 soumet le score ➜ WAITING_VALIDATION (sans progression de bracket)
    const cap1Report = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(cap1Report.status).toBe(200);
    expect(db.current?.tables.matches?.[0]).toMatchObject({
      team1_score: 3,
      team2_score: 1,
      status: "WAITING_VALIDATION",
      reported_by_team_id: TEAM_1,
    });
    expect(progressTeams).not.toHaveBeenCalled();

    // 4. Le même capitaine tente de revalider son propre score ➜ refus 400
    const cap1SelfConfirm = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(cap1SelfConfirm.status).toBe(400);
    expect((cap1SelfConfirm.body as { error: string }).error).toContain("capitaine adverse");

    // 5. Le capitaine adverse (Team 2) confirme ➜ COMPLETED et progression
    const cap2Confirm = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-2" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(cap2Confirm.status).toBe(200);
    expect(db.current?.tables.matches?.[0]?.status).toBe("COMPLETED");
    expect(progressTeams).toHaveBeenCalledTimes(1);

    // 6. Concurrence : une seconde confirmation sur le match déjà COMPLETED ➜ refusé (0 progression supplémentaire)
    const duplicateConfirm = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-2" },
      body: { team1_score: 3, team2_score: 1 },
    });
    expect(duplicateConfirm.status).toBe(400);
    expect(progressTeams).toHaveBeenCalledTimes(1); // Toujours 1 seule fois !
  });
});
