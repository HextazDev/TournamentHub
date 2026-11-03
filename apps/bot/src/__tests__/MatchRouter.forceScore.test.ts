import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";
import { callRoute } from "./helpers/route";
import type { AdminCheck } from "../middleware/auth";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const tenant = vi.hoisted(() => ({ allowed: true }));

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
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: (req: { adminCheck?: AdminCheck }) => req.adminCheck?.guildId ?? null,
  verifyMatchGuild: vi.fn(async () => tenant.allowed),
}));

import { matchRouter } from "../routes/MatchRouter";

const adminCheck: AdminCheck = { discordId: "to-1", guildId: "guild-1", access: { level: "SERVER", reason: "TO_ROLE" } };

function seedGroupPhase() {
  db.current = new FakeSupabase({
    phases: [{ id: "phase-1", format: "ROUND_ROBIN", settings: {} }],
    groups: [{ id: "group-1", phase_id: "phase-1" }],
    phase_teams: [
      { phase_id: "phase-1", team_id: "A", group_id: "group-1", points: 0, wins: 0 },
      { phase_id: "phase-1", team_id: "B", group_id: "group-1", points: 0, wins: 0 },
    ],
    matches: [{
      id: "match-1", phase_id: "phase-1", group_id: "group-1",
      team1_id: "A", team2_id: "B", team1_score: 0, team2_score: 0, status: "PENDING",
      next_match_winner_id: null, next_match_loser_id: null, discord_channel_id: null,
    }],
  });
  return db.current;
}

function forceScore(team1_score: number, team2_score: number) {
  return callRoute(matchRouter, {
    method: "PUT",
    path: "/match-1/force-score",
    body: { team1_score, team2_score, guildId: "guild-1" },
    adminCheck,
  });
}

describe("PUT /:id/force-score — classement des poules (#51)", () => {
  beforeEach(() => {
    tenant.allowed = true;
  });

  it("LB-06: score forcé sur un match de poule ➜ phase_teams recalculé (Discord = web)", async () => {
    const fake = seedGroupPhase();
    const res = await forceScore(2, 1);

    expect(res.status).toBe(200);
    const teams = fake.tables.phase_teams ?? [];
    expect(teams.find((t) => t.team_id === "A")).toMatchObject({ played: 1, wins: 1, points: 3, differential: 1 });
    expect(teams.find((t) => t.team_id === "B")).toMatchObject({ played: 1, losses: 1, points: 0, differential: -1 });
  });

  it("SEC: match d'un autre serveur ➜ 403, aucun score ni classement écrit", async () => {
    const fake = seedGroupPhase();
    tenant.allowed = false;
    const res = await forceScore(2, 1);

    expect(res.status).toBe(403);
    expect(fake.writes).toEqual([]);
  });
});
