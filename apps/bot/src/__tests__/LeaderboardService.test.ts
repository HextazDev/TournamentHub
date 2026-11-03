import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ from: vi.fn<(table: string) => unknown>() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../utils/logger";
import { LeaderboardService } from "../services/LeaderboardService";

type Row = Record<string, unknown>;
type Fixture = { settings: unknown; teams: string[]; matches: Row[] };
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
    const result = () => {
      if (table === "groups") return { data: { phase_id: "phase-1" }, error: null };
      if (table === "phases") return { data: { settings: fixture.settings }, error: null };
      if (table === "matches") return { data: fixture.matches, error: null };
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
      in: () => builder,
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

const matches: Row[] = [
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
