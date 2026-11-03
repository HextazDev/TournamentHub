import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/LeaderboardService", () => ({
  LeaderboardService: { calculateSwissStandings: vi.fn().mockResolvedValue(undefined) },
}));

import { SwissGeneratorService } from "../services/SwissGeneratorService";

function seedAfterRound1() {
  db.current = new FakeSupabase({
    phase_teams: [
      { phase_id: "phase-1", team_id: "t1", points: 3, wins: 1 },
      { phase_id: "phase-1", team_id: "t2", points: 0, wins: 0 },
      { phase_id: "phase-1", team_id: "t3", points: 3, wins: 1 },
      { phase_id: "phase-1", team_id: "t4", points: 0, wins: 0 },
    ],
    matches: [
      { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
      { id: "m2", phase_id: "phase-1", round_number: 1, team1_id: "t3", team2_id: "t4", status: "COMPLETED" },
    ],
  });
  return db.current;
}

const roundMatches = (fake: FakeSupabase, round: number) =>
  (fake.tables.matches ?? []).filter(m => m.phase_id === "phase-1" && m.round_number === round);

describe("SwissGeneratorService.generateNextRound - SWS-06 anti-doublon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("génère la ronde suivante quand elle n'existe pas encore", async () => {
    const fake = seedAfterRound1();

    const generated = await SwissGeneratorService.generateNextRound("phase-1", 2);

    expect(generated).toBe(true);
    expect(roundMatches(fake, 2)).toHaveLength(2);
  });

  it("SWS-06: appelé deux fois pour la même ronde ➜ une seule génération", async () => {
    const fake = seedAfterRound1();

    const first = await SwissGeneratorService.generateNextRound("phase-1", 2);
    const second = await SwissGeneratorService.generateNextRound("phase-1", 2);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(roundMatches(fake, 2)).toHaveLength(2);
    expect(fake.writesTo("matches", "insert")).toHaveLength(1);
  });
});
