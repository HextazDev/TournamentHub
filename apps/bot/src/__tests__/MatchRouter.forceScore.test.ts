import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";
import { callRoute } from "./helpers/route";
import type { AdminCheck } from "../middleware/auth";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const tenant = vi.hoisted(() => ({ allowed: true }));

const rpc = vi.hoisted(() => ({ calls: [] as { name: string; args: Record<string, unknown> }[] }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
    // assign_team_to_match (SCR-07) : place l'équipe dans le premier slot libre du match cible.
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpc.calls.push({ name, args });
      const target = db.current?.tables.matches?.find((m) => m.id === args.p_target_match_id);
      if (!target) return { data: [], error: null };
      if (!target.team1_id) target.team1_id = args.p_team_id;
      else if (!target.team2_id) target.team2_id = args.p_team_id;
      else return { data: [], error: null };
      return { data: [{ ...target }], error: null };
    },
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: (req: { adminCheck?: AdminCheck }) => req.adminCheck?.guildId ?? null,
  verifyMatchGuild: vi.fn(async () => tenant.allowed),
  resolveOrganization: vi.fn(async () => ({ id: "org-1", slug: "org", discordEnabled: true, discordGuildId: "guild-1" })),
}));

import { matchRouter } from "../routes/MatchRouter";

const adminCheck: AdminCheck = { discordId: "to-1", guildId: "guild-1", access: { level: "SERVER", reason: "TO_ROLE" } };

function seedGroupPhase(settings: Record<string, unknown> = {}) {
  db.current = new FakeSupabase({
    phases: [{ id: "phase-1", format: "ROUND_ROBIN", settings }],
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

function seedEliminationPhase() {
  db.current = new FakeSupabase({
    phases: [{ id: "phase-e", format: "SINGLE_ELIM", settings: {} }],
    matches: [
      {
        id: "match-1", phase_id: "phase-e", group_id: null,
        team1_id: "A", team2_id: "B", team1_score: 0, team2_score: 0, status: "PENDING",
        next_match_winner_id: "match-2", next_match_loser_id: null, discord_channel_id: null,
      },
      {
        id: "match-2", phase_id: "phase-e", group_id: null,
        team1_id: null, team2_id: "C", team1_score: 0, team2_score: 0, status: "PENDING",
        next_match_winner_id: null, next_match_loser_id: null, discord_channel_id: null,
      },
    ],
  });
  return db.current;
}

function putForceScore(body: unknown) {
  return callRoute(matchRouter, { method: "PUT", path: "/match-1/force-score", body, adminCheck });
}

function forceScore(team1_score: number, team2_score: number, status: "COMPLETED" | "FF" = "COMPLETED") {
  return putForceScore({ team1_score, team2_score, status, guildId: "guild-1" });
}

const statusOf = (fake: FakeSupabase, id: string) => fake.tables.matches?.find((m) => m.id === id)?.status;

describe("PUT /:id/force-score — classement des poules (#51)", () => {
  beforeEach(() => {
    tenant.allowed = true;
    rpc.calls = [];
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

describe("PUT /:id/force-score — forfait déclaré par un TO (#77)", () => {
  beforeEach(() => {
    tenant.allowed = true;
    rpc.calls = [];
  });

  it("SCR-10: forfait 3-0 ➜ match enregistré FF, forfait exclusif appliqué au perdant (LB-05)", async () => {
    const fake = seedGroupPhase({ points_win: 3, points_loss: 1, points_forfeit: -1 });
    const res = await forceScore(3, 0, "FF");

    expect(res.status).toBe(200);
    expect(statusOf(fake, "match-1")).toBe("FF");
    const teams = fake.tables.phase_teams ?? [];
    expect(teams.find((t) => t.team_id === "A")).toMatchObject({ played: 1, wins: 1, forfeits: 0, points: 3 });
    expect(teams.find((t) => t.team_id === "B")).toMatchObject({ played: 1, losses: 0, forfeits: 1, points: -1 });
  });

  it("SCR-10: score ordinaire ➜ match enregistré COMPLETED, le perdant prend une défaite", async () => {
    const fake = seedGroupPhase({ points_win: 3, points_loss: 1, points_forfeit: -1 });
    const res = await forceScore(2, 1, "COMPLETED");

    expect(res.status).toBe(200);
    expect(statusOf(fake, "match-1")).toBe("COMPLETED");
    const teams = fake.tables.phase_teams ?? [];
    expect(teams.find((t) => t.team_id === "B")).toMatchObject({ played: 1, losses: 1, forfeits: 0, points: 1 });
  });

  it.each([
    ["statut hors liste (BYE)", { team1_score: 1, team2_score: 0, status: "BYE" }],
    ["statut absent", { team1_score: 1, team2_score: 0 }],
    ["score décimal", { team1_score: 1.5, team2_score: 0, status: "COMPLETED" }],
    ["score négatif", { team1_score: -1, team2_score: 0, status: "FF" }],
    ["score > 99", { team1_score: 100, team2_score: 0, status: "COMPLETED" }],
    ["score en chaîne", { team1_score: "3", team2_score: 0, status: "FF" }],
  ])("SCR-01 / SCR-10: corps invalide (%s) ➜ 400, aucune écriture", async (_label, body) => {
    const fake = seedGroupPhase();
    const res = await putForceScore({ ...body, guildId: "guild-1" });

    expect(res.status).toBe(400);
    expect(fake.writes).toEqual([]);
    expect(statusOf(fake, "match-1")).toBe("PENDING");
  });

  it("SCR-10: forfait 2-0 en élimination ➜ match FF, le vainqueur progresse au match suivant", async () => {
    const fake = seedEliminationPhase();
    const res = await forceScore(2, 0, "FF");

    expect(res.status).toBe(200);
    expect(statusOf(fake, "match-1")).toBe("FF");
    expect(rpc.calls).toEqual([
      { name: "assign_team_to_match", args: { p_target_match_id: "match-2", p_team_id: "A" } },
    ]);
    expect(fake.tables.matches?.find((m) => m.id === "match-2")).toMatchObject({ team1_id: "A", team2_id: "C" });
  });
});
