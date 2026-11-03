import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ from: vi.fn<(table: string) => unknown>() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { computeStandings, resolveGroupPoints, type StandingsMatch } from "@hub/shared";
import { logger } from "../utils/logger";
import { LeaderboardService } from "../services/LeaderboardService";

type Row = Record<string, unknown>;
type Fixture = { settings: unknown; teams: string[]; matches: StandingsMatch[] };
type Update = { team_id: unknown; payload: Row };

/**
 * Supabase simulé à la frontière : chaque `from(table)` renvoie un builder chaînable
 * et « thenable », et les `update()` sur `phase_teams` sont capturés.
 */
function mockGroup(fixture: Fixture): Update[] {
  const updates: Update[] = [];
  db.from.mockImplementation((table: string) => {
    let payload: Row | null = null;
    const filters: Record<string, unknown> = {};
    let statusFilter: unknown[] | null = null;
    const result = () => {
      if (table === "groups") return { data: { phase_id: "phase-1" }, error: null };
      if (table === "phases") return { data: { settings: fixture.settings }, error: null };
      if (table === "matches") {
        // Applique le filtre `.in("status", …)` comme le ferait PostgreSQL.
        const allowed = statusFilter;
        const rows = allowed ? fixture.matches.filter((m) => allowed.includes(m.status)) : fixture.matches;
        return { data: rows, error: null };
      }
      if (table === "phase_teams" && payload) {
        updates.push({ team_id: filters.team_id, payload });
        return { data: null, error: null };
      }
      if (table === "phase_teams") {
        return { data: fixture.teams.map((team_id) => ({ team_id, phase_id: "phase-1" })), error: null };
      }
      return { data: null, error: null };
    };
    const builder = {
      select: () => builder,
      in: (col: string, values: unknown[]) => {
        if (col === "status") statusFilter = values;
        return builder;
      },
      update: (p: Row) => {
        payload = p;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      single: () => Promise.resolve(result()),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  return updates;
}

const matches: StandingsMatch[] = [
  // A bat B, A fait nul avec C, C bat B
  { team1_id: "A", team2_id: "B", team1_score: 2, team2_score: 0, status: "COMPLETED" },
  { team1_id: "A", team2_id: "C", team1_score: 1, team2_score: 1, status: "COMPLETED" },
  { team1_id: "C", team2_id: "B", team1_score: 3, team2_score: 1, status: "COMPLETED" },
];

function pointsOf(updates: Update[]): Record<string, unknown> {
  return Object.fromEntries(updates.map((u) => [u.team_id, u.payload.points]));
}

describe("LeaderboardService.calculateGroupStandings — barème des poules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LB-03: settings {} ➜ barème 3 / 1 / 0", async () => {
    const updates = mockGroup({ settings: {}, teams: ["A", "B", "C"], matches });
    await LeaderboardService.calculateGroupStandings("group-1");
    expect(pointsOf(updates)).toEqual({ A: 4, B: 0, C: 4 });
  });

  it("LB-03: valeurs vides enregistrées (\"\") ➜ repli sur le barème par défaut, pas 0 point", async () => {
    const updates = mockGroup({
      settings: { points_win: "", points_draw: "", points_loss: "", points_forfeit: "" },
      teams: ["A", "B", "C"],
      matches,
    });
    await LeaderboardService.calculateGroupStandings("group-1");
    expect(pointsOf(updates)).toEqual({ A: 4, B: 0, C: 4 });
  });

  it("LB-04: barème personnalisé de l'organisateur appliqué fidèlement", async () => {
    const updates = mockGroup({
      settings: { points_win: 2, points_draw: 0, points_loss: 1 },
      teams: ["A", "B", "C"],
      matches,
    });
    await LeaderboardService.calculateGroupStandings("group-1");
    // A : 1V 1N ➜ 2 ; B : 2D ➜ 2 ; C : 1V 1N ➜ 2
    expect(pointsOf(updates)).toEqual({ A: 2, B: 2, C: 2 });
  });

  it("LB-02: JSON settings malformé ➜ barème par défaut, pas de crash", async () => {
    const updates = mockGroup({ settings: "{not json", teams: ["A", "B", "C"], matches });
    await LeaderboardService.calculateGroupStandings("group-1");
    expect(pointsOf(updates)).toEqual({ A: 4, B: 0, C: 4 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Malformed settings JSON"), expect.any(SyntaxError));
  });

  it("LB-02: settings JSON sérialisé en chaîne ➜ barème lu correctement", async () => {
    const updates = mockGroup({ settings: JSON.stringify({ points_win: 5 }), teams: ["A", "B", "C"], matches });
    await LeaderboardService.calculateGroupStandings("group-1");
    expect(pointsOf(updates)).toEqual({ A: 6, B: 0, C: 6 });
  });
});

function standingOf(updates: Update[], teamId: string): Row {
  const update = updates.find((u) => u.team_id === teamId);
  if (!update) throw new Error(`Aucune écriture phase_teams pour ${teamId}`);
  return update.payload;
}

describe("LeaderboardService.calculateGroupStandings — forfaits et BYE (#51)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LB-05: match FF en poules ➜ persisté en forfait exclusif (pas ignoré, pas de défaite cumulée)", async () => {
    const updates = mockGroup({
      settings: { points_win: 3, points_loss: 1, points_forfeit: -1 },
      teams: ["A", "B"],
      matches: [{ team1_id: "A", team2_id: "B", team1_score: 0, team2_score: 3, status: "FF" }],
    });
    await LeaderboardService.calculateGroupStandings("group-1");
    expect(standingOf(updates, "A")).toMatchObject({ played: 1, losses: 0, forfeits: 1, points: -1 });
    expect(standingOf(updates, "B")).toMatchObject({ played: 1, wins: 1, forfeits: 0, points: 3 });
  });

  it("LB-06: valeurs persistées identiques au calcul partagé utilisé par le web", async () => {
    const settings = { points_win: 2, points_draw: 1, points_loss: 0, points_forfeit: -2 };
    const groupMatches: StandingsMatch[] = [
      ...matches,
      { team1_id: "B", team2_id: "C", team1_score: 0, team2_score: 0, status: "FF" },
      { team1_id: "A", team2_id: null, team1_score: 1, team2_score: 0, status: "COMPLETED" },
      { team1_id: "C", team2_id: "A", team1_score: 5, team2_score: 0, status: "PENDING" },
    ];
    const updates = mockGroup({ settings, teams: ["A", "B", "C"], matches: groupMatches });
    await LeaderboardService.calculateGroupStandings("group-1");

    const expected = computeStandings(["A", "B", "C"], groupMatches, resolveGroupPoints(settings));
    for (const teamId of ["A", "B", "C"]) {
      expect(standingOf(updates, teamId)).toEqual(expected.get(teamId));
    }
  });
});

describe("LeaderboardService.calculateSwissStandings — barème phase.settings (#51)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const swissMatches: StandingsMatch[] = [
    { team1_id: "A", team2_id: "B", team1_score: 2, team2_score: 1, status: "COMPLETED" },
    { team1_id: "C", team2_id: "D", team1_score: 1, team2_score: 1, status: "COMPLETED" },
    { team1_id: "E", team2_id: null, team1_score: 1, team2_score: 0, status: "BYE" },
  ];

  it("SWS-05: barème personnalisé appliqué, BYE inclus (plus de 3 / 1 / 0 en dur)", async () => {
    const updates = mockGroup({
      settings: { points_win: 2, points_draw: 0, points_loss: 1 },
      teams: ["A", "B", "C", "D", "E"],
      matches: swissMatches,
    });
    await LeaderboardService.calculateSwissStandings("phase-1");
    expect(pointsOf(updates)).toEqual({ A: 2, B: 1, C: 0, D: 0, E: 2 });
    expect(standingOf(updates, "E")).toMatchObject({ played: 1, wins: 1 });
  });

  it("SWS-05: settings {} ➜ barème par défaut 3 / 1 / 0, BYE = 3 pts (non-régression)", async () => {
    const updates = mockGroup({ settings: {}, teams: ["A", "B", "C", "D", "E"], matches: swissMatches });
    await LeaderboardService.calculateSwissStandings("phase-1");
    expect(pointsOf(updates)).toEqual({ A: 3, B: 0, C: 1, D: 1, E: 3 });
  });

  it("LB-02: settings Suisse malformé ➜ barème par défaut, erreur journalisée", async () => {
    const updates = mockGroup({ settings: "{not json", teams: ["A", "B", "C", "D", "E"], matches: swissMatches });
    await LeaderboardService.calculateSwissStandings("phase-1");
    expect(pointsOf(updates)).toEqual({ A: 3, B: 0, C: 1, D: 1, E: 3 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Malformed settings JSON"), expect.any(SyntaxError));
  });

  it("LB-05: FF en Suisse ➜ forfait exclusif comme en poules", async () => {
    const updates = mockGroup({
      settings: { points_forfeit: -1 },
      teams: ["A", "B"],
      matches: [{ team1_id: "A", team2_id: "B", team1_score: 3, team2_score: 0, status: "FF" }],
    });
    await LeaderboardService.calculateSwissStandings("phase-1");
    expect(standingOf(updates, "B")).toMatchObject({ losses: 0, forfeits: 1, points: -1 });
  });
});
