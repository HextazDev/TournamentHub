import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const progressTeams = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));

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
    db.current!.tables.teams![0]!.is_checked_in = true;
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

  it("ARC-02: refuse de relancer un tournoi déjà ACTIVE", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
      body: { uncheckedTeams: "keep" },
    });
    expect(res.status).toBe(400);
  });

  it("LCH-01: sans choix du TO, des équipes non check-in bloquent le lancement sans rien supprimer", async () => {
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "UNCHECKED_TEAMS", uncheckedCount: 1 });
    expect(db.current?.tables.teams).toHaveLength(2);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("REGISTRATION");
  });

  it("LCH-02: `keep` conserve les équipes non check-in et lance", async () => {
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
      body: { uncheckedTeams: "keep" },
    });
    expect(res.status).toBe(200);
    expect(db.current?.tables.teams).toHaveLength(2);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("ACTIVE");
  });

  it("LCH-03: `remove` retire uniquement les non check-in, après le passage à ACTIVE", async () => {
    db.current!.tables.teams!.push({ id: "t3", tournament_id: T_WEB, name: "Third", captain_discord_id: "cap-x", is_checked_in: true });
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
      body: { uncheckedTeams: "remove" },
    });
    expect(res.status).toBe(200);
    expect(db.current?.tables.teams?.map((t) => t.id).sort()).toEqual([TEAM_2, "t3"].sort());
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("ACTIVE");
    const writes = db.current!.writes.map((w) => `${w.table}:${w.op}`);
    expect(writes.indexOf("tournaments:update")).toBeLessThan(writes.indexOf("teams:delete"));
  });

  it("LCH-04: `remove` refuse de retirer une équipe déjà placée dans une phase", async () => {
    db.current!.tables.phase_teams = [{ phase_id: PHASE_1, team_id: TEAM_1 }];
    db.current!.tables.teams!.push({ id: "t3", tournament_id: T_WEB, name: "Third", captain_discord_id: "cap-x", is_checked_in: true });
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
      body: { uncheckedTeams: "remove" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "UNCHECKED_TEAMS_PLACED" });
    expect(db.current?.tables.teams).toHaveLength(3);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("REGISTRATION");
  });

  it("LCH-05: check-in DISABLED ➜ aucune équipe n'est considérée non check-in", async () => {
    db.current!.tables.tournaments![0]!.checkin_mode = "DISABLED";
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(res.status).toBe(200);
    expect(db.current?.tables.teams).toHaveLength(2);
  });

  it("LCH-06: refuse un lancement sans phase ou avec moins de 2 équipes restantes", async () => {
    db.current!.tables.tournaments![0]!.checkin_mode = "DISABLED";
    db.current!.tables.phases = [];
    const noPhase = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
    });
    expect(noPhase.status).toBe(400);
    db.current!.tables.phases = [{ id: PHASE_1, tournament_id: T_WEB, name: "Bracket", format: "SINGLE_ELIM", phase_order: 1 }];
    db.current!.tables.tournaments![0]!.checkin_mode = "ENABLED";
    const tooFew = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/launch`,
      adminCheck: orgOwnerCheck,
      body: { uncheckedTeams: "remove" },
    });
    expect(tooFew.status).toBe(400);
    expect(db.current?.tables.teams).toHaveLength(2);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("REGISTRATION");
  });

  it("LCH-07: la clôture exige un tournoi ACTIVE", async () => {
    const res = await callRoute(tournamentRouter, {
      method: "POST",
      path: `/${T_WEB}/close`,
      adminCheck: orgOwnerCheck,
    });
    expect(res.status).toBe(400);
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("REGISTRATION");
  });

  it("DAT-02: refuse un code ami invalide à l'inscription Web, capitaine comme joueur", async () => {
    db.current!.tables.tournaments![0]!.is_registration_open = true;
    for (const body of [
      { name: "Bad", captain_ingame_name: "x", captain_friend_code: "pas-un-code" },
      { name: "Bad", captain_ingame_name: "x", captain_friend_code: "SW-1234-5678-9012", members: [{ ingame_name: "y", friend_code: "1234" }] },
    ]) {
      const res = await callRoute(playerRouter, {
        method: "POST",
        path: `/tournaments/${T_WEB}/register`,
        headers: { "x-discord-user-id": "cap-9" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(db.current?.tables.teams).toHaveLength(2);
  });

  it("SCR-11: un score adverse différent ne valide pas le match et ne fait rien progresser", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 2, team2_score: 0 },
    });
    const res = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-2" },
      body: { team1_score: 0, team2_score: 2 },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SCORE_MISMATCH" });
    expect(db.current?.tables.matches?.[0]).toMatchObject({ status: "WAITING_VALIDATION", team1_score: 2, team2_score: 0 });
    expect(progressTeams).not.toHaveBeenCalled();
  });

  it("SCR-11: la validation fait progresser le vainqueur du score enregistré", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 2, team2_score: 0 },
    });
    const res = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-2" },
      body: { team1_score: 2, team2_score: 0 },
    });
    expect(res.status).toBe(200);
    expect(progressTeams).toHaveBeenCalledTimes(1);
    expect(progressTeams.mock.calls[0]?.[2]).toBe(TEAM_1);
    expect(progressTeams.mock.calls[0]?.[3]).toBe(TEAM_2);
  });

  it("SCR-12: le capitaine adverse conteste ➜ CONTESTED, sans progression ; le déclarant et un tiers sont refusés", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "cap-1" },
      body: { team1_score: 2, team2_score: 0 },
    });
    for (const user of ["cap-1", "random-user"]) {
      const denied = await callRoute(playerRouter, {
        method: "POST",
        path: `/matches/${MATCH_1}/contest-score`,
        headers: { "x-discord-user-id": user },
      });
      expect(denied.status).toBe(403);
    }
    const res = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/contest-score`,
      headers: { "x-discord-user-id": "cap-2" },
    });
    expect(res.status).toBe(200);
    expect(db.current?.tables.matches?.[0]?.status).toBe("CONTESTED");
    expect(progressTeams).not.toHaveBeenCalled();
    const again = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/contest-score`,
      headers: { "x-discord-user-id": "cap-2" },
    });
    expect(again.status).toBe(400);
  });

  it("SEC-31: le staff ne peut pas saisir le score d'un match sans ses deux équipes", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    db.current!.tables.matches![0]!.team2_id = null;
    const res = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "u-owner" },
      body: { team1_score: 3, team2_score: 0 },
    });
    expect(res.status).toBe(400);
    expect(db.current?.tables.matches?.[0]?.status).toBe("PENDING");
    expect(progressTeams).not.toHaveBeenCalled();
  });

  it("SEC-31: le staff résout un match contesté", async () => {
    db.current!.tables.tournaments![0]!.status = "ACTIVE";
    db.current!.tables.matches![0]!.status = "CONTESTED";
    const res = await callRoute(playerRouter, {
      method: "POST",
      path: `/matches/${MATCH_1}/report-score`,
      headers: { "x-discord-user-id": "u-owner" },
      body: { team1_score: 3, team2_score: 0 },
    });
    expect(res.status).toBe(200);
    expect(db.current?.tables.matches?.[0]?.status).toBe("COMPLETED");
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

  describe("SEC-10: inscription et lien de partage d'un tournoi privé", () => {
    const body = { name: "Private", captain_ingame_name: "x", captain_friend_code: "SW-1234-5678-9012" };
    beforeEach(() => {
      const row = db.current!.tables.tournaments![0]!;
      row.is_public = false;
      row.is_registration_open = true;
    });

    it("refuse un inconnu, sans jeton ni appartenance", async () => {
      const res = await callRoute(playerRouter, {
        method: "POST", path: `/tournaments/${T_WEB}/register`, headers: { "x-discord-user-id": "stranger" }, body,
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "PRIVATE_TOURNAMENT" });
    });

    it("le TO génère un lien, stocké haché, et son jeton ouvre l'inscription", async () => {
      const link = await callRoute(tournamentRouter, {
        method: "POST", path: `/${T_WEB}/invite-link`, adminCheck: orgOwnerCheck,
      });
      expect(link.status).toBe(201);
      const { token } = link.body as { token: string };
      expect(db.current?.tables.tournament_invite_tokens?.[0]?.token_hash).not.toBe(token);

      const wrong = await callRoute(playerRouter, {
        method: "POST", path: `/tournaments/${T_WEB}/register`, headers: { "x-discord-user-id": "stranger" },
        body: { ...body, invite_token: "x".repeat(43) },
      });
      expect(wrong.status).toBe(403);

      const ok = await callRoute(playerRouter, {
        method: "POST", path: `/tournaments/${T_WEB}/register`, headers: { "x-discord-user-id": "stranger" },
        body: { ...body, invite_token: token },
      });
      expect(ok.status).toBe(201);
    });

    it("régénérer invalide l'ancien lien, révoquer le supprime", async () => {
      const first = await callRoute(tournamentRouter, { method: "POST", path: `/${T_WEB}/invite-link`, adminCheck: orgOwnerCheck });
      await callRoute(tournamentRouter, { method: "POST", path: `/${T_WEB}/invite-link`, adminCheck: orgOwnerCheck });
      expect(db.current?.tables.tournament_invite_tokens).toHaveLength(1);
      const stale = await callRoute(playerRouter, {
        method: "POST", path: `/tournaments/${T_WEB}/register`, headers: { "x-discord-user-id": "stranger" },
        body: { ...body, invite_token: (first.body as { token: string }).token },
      });
      expect(stale.status).toBe(403);
      const revoke = await callRoute(tournamentRouter, { method: "DELETE", path: `/${T_WEB}/invite-link`, adminCheck: orgOwnerCheck });
      expect(revoke.status).toBe(200);
      expect(db.current?.tables.tournament_invite_tokens).toEqual([]);
    });

    it("un staff du tournoi peut s'inscrire", async () => {
      db.current!.tables.tournament_staff = [{ tournament_id: T_WEB, user_id: "staff-1", role: "CASTER" }];
      const res = await callRoute(playerRouter, {
        method: "POST", path: `/tournaments/${T_WEB}/register`, headers: { "x-discord-user-id": "staff-1" }, body,
      });
      expect(res.status).toBe(201);
    });
  });
});
