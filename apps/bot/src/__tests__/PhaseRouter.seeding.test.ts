import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
const tenant = vi.hoisted(() => ({ verifyPhaseGuild: vi.fn() }));
const generators = vi.hoisted(() => ({ generateBracket: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyPhaseGuild: tenant.verifyPhaseGuild,
  verifyTournamentGuild: vi.fn(),
}));
vi.mock("../services/BracketGeneratorService", () => ({
  BracketGeneratorService: { generateBracket: generators.generateBracket },
}));
vi.mock("../services/RoundRobinGeneratorService", () => ({ RoundRobinGeneratorService: {} }));
vi.mock("../services/LifecycleService", () => ({ LifecycleService: {} }));

import { MAX_PHASE_SEEDS } from "@hub/shared";
import { phaseRouter } from "../routes/PhaseRouter";
import { callRoute } from "./helpers/route";

const PHASE_ID = "phase-1";
const TOURNAMENT_ID = "6f1c2a6e-3b7d-4c8e-9f10-aaaaaaaaaaaa";
const OTHER_TOURNAMENT_ID = "6f1c2a6e-3b7d-4c8e-9f10-bbbbbbbbbbbb";
const TEAM_A = "6f1c2a6e-3b7d-4c8e-9f10-112233445501";
const TEAM_B = "6f1c2a6e-3b7d-4c8e-9f10-112233445502";
const TEAM_C = "6f1c2a6e-3b7d-4c8e-9f10-112233445503";
const adminCheck = { discordId: "to", guildId: "111", access: { level: "SERVER", reason: "TO_ROLE" } } as const;

interface MatchRow {
  id: string;
  status: string;
  team1_id: string | null;
  team2_id: string | null;
  team1_score: number | null;
  team2_score: number | null;
}

let matches: MatchRow[];
/** Équipes en base : `tournament_id` de chacune (la phase appartient à TOURNAMENT_ID). */
let teams: { id: string; tournament_id: string }[];
let teamsReadError: { code: string; message: string } | null;
/** Toute écriture destructrice : RPC de placement ou suppression directe. */
let writes: string[];

function wireDb() {
  db.rpc.mockImplementation(async (name: string) => {
    writes.push(`rpc:${name}`);
    return { error: null };
  });
  db.from.mockImplementation((table: string) => {
    if (table === "matches") {
      return {
        select: () => ({ eq: async () => ({ data: matches, error: null }) }),
        delete: () => {
          writes.push("delete:matches");
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "phase_teams") {
      return {
        delete: () => {
          writes.push("delete:phase_teams");
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "teams") {
      return {
        select: () => ({
          in: (_column: string, ids: readonly string[]) => ({
            eq: async (_col: string, tournamentId: string) =>
              teamsReadError
                ? { data: null, error: teamsReadError }
                : { data: teams.filter((t) => ids.includes(t.id) && t.tournament_id === tournamentId).map((t) => ({ id: t.id })), error: null },
          }),
        }),
      };
    }
    if (table === "phases") {
      return {
        select: (columns: string) => ({
          eq: () => ({
            single: async () =>
              columns.includes("tournaments")
                ? { data: { tournaments: { guild_id: "111", status: "DRAFT" } }, error: null }
                : columns === "tournament_id"
                  ? { data: { tournament_id: TOURNAMENT_ID }, error: null }
                  : { data: { bracket_size: 4, format: "SINGLE_ELIM", max_groups: 1 }, error: null },
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

function realMatch(status: string, team1_score: number | null = 0, team2_score: number | null = 0): MatchRow {
  return { id: `m-${status}`, status, team1_id: TEAM_A, team2_id: TEAM_B, team1_score, team2_score };
}

/** Corps exact envoyé par PlacementPhaseClient (`guildId` inclus, seed négatif = départ en bracket perdant). */
const webBody = {
  participants: [
    { team_id: TEAM_A, seed: 1 },
    { team_id: TEAM_B, seed: -2 },
  ],
  guildId: "111",
};

function putSeeding(body: unknown) {
  return callRoute(phaseRouter, { method: "PUT", path: `/${PHASE_ID}/seeding`, body, adminCheck });
}

beforeEach(() => {
  vi.clearAllMocks();
  matches = [];
  writes = [];
  teams = [TEAM_A, TEAM_B, TEAM_C].map((id) => ({ id, tournament_id: TOURNAMENT_ID }));
  teamsReadError = null;
  tenant.verifyPhaseGuild.mockResolvedValue(true);
  generators.generateBracket.mockResolvedValue(undefined);
  wireDb();
});

describe("PUT /api/phases/:id/seeding — SCR-09 match commencé", () => {
  it.each([
    ["FF", 0, 0],
    ["WAITING_VALIDATION", 0, 0],
    ["CONTESTED", 0, 0],
    ["COMPLETED", 0, 0],
    ["PENDING", 1, 0],
  ])("SCR-09: match réel %s %i-%i ➜ 400 et aucune suppression", async (status, s1, s2) => {
    matches = [realMatch("PENDING"), realMatch(status, s1, s2)];
    const out = await putSeeding(webBody);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: "Impossible de modifier le placement : des matchs ont déjà des scores ou sont terminés.",
    });
    expect(writes).toEqual([]);
    expect(generators.generateBracket).not.toHaveBeenCalled();
  });

  it("SCR-09: tous les matchs réels PENDING sans score (0-0 ou null) ➜ re-seed accepté", async () => {
    matches = [realMatch("PENDING", 0, 0), { ...realMatch("PENDING", null, null), id: "m-null" }];
    const out = await putSeeding(webBody);
    expect(out.status).toBe(200);
    expect(writes).toEqual(["rpc:regenerate_phase_seeding"]);
    expect(db.rpc).toHaveBeenCalledWith("regenerate_phase_seeding", {
      p_phase_id: PHASE_ID,
      p_participants: webBody.participants,
    });
    expect(generators.generateBracket).toHaveBeenCalledWith(PHASE_ID, 4);
  });

  it("SCR-09: un BYE (une seule équipe) est ignoré, quel que soit son statut", async () => {
    matches = [
      realMatch("PENDING"),
      { id: "bye-1", status: "BYE", team1_id: TEAM_A, team2_id: null, team1_score: 0, team2_score: 0 },
      { id: "bye-2", status: "COMPLETED", team1_id: null, team2_id: TEAM_C, team1_score: 1, team2_score: 0 },
    ];
    const out = await putSeeding(webBody);
    expect(out.status).toBe(200);
    expect(writes).toEqual(["rpc:regenerate_phase_seeding"]);
  });

  it("SEC-01: phase d'un autre serveur ➜ 403 avant toute lecture ou écriture", async () => {
    tenant.verifyPhaseGuild.mockResolvedValue(false);
    const out = await putSeeding(webBody);
    expect(out.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("PUT /api/phases/:id/seeding — PH-02 validation du corps", () => {
  it("PH-02: corps réel du web (guildId en plus) ➜ accepté, guildId non transmis au RPC", async () => {
    const out = await putSeeding(webBody);
    expect(out.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("regenerate_phase_seeding", {
      p_phase_id: PHASE_ID,
      p_participants: webBody.participants,
    });
  });

  it("PH-02: participants vide ➜ phase vidée (comportement conservé)", async () => {
    const out = await putSeeding({ participants: [], guildId: "111" });
    expect(out.status).toBe(200);
    expect(writes).toEqual(["delete:matches", "delete:phase_teams"]);
  });

  const tooMany = Array.from({ length: MAX_PHASE_SEEDS + 1 }, (_, i) => ({
    team_id: `6f1c2a6e-3b7d-4c8e-9f10-${String(i).padStart(12, "0")}`,
    seed: i + 1,
  }));

  it.each([
    ["participants absent", { guildId: "111" }],
    ["participants non tableau", { participants: "x" }],
    ["team_id non UUID", { participants: [{ team_id: "abc", seed: 1 }] }],
    ["seed nul", { participants: [{ team_id: TEAM_A, seed: 0 }] }],
    ["seed décimal", { participants: [{ team_id: TEAM_A, seed: 1.5 }] }],
    ["seed chaîne", { participants: [{ team_id: TEAM_A, seed: "1" }] }],
    ["seed hors bornes", { participants: [{ team_id: TEAM_A, seed: MAX_PHASE_SEEDS + 1 }] }],
    ["équipe en double", { participants: [{ team_id: TEAM_A, seed: 1 }, { team_id: TEAM_A, seed: 2 }] }],
    ["même emplacement 3 / -3", { participants: [{ team_id: TEAM_A, seed: 3 }, { team_id: TEAM_B, seed: -3 }] }],
    ["trop de participants", { participants: tooMany }],
  ])("PH-02: %s ➜ 400 et aucune écriture", async (_label, body) => {
    const out = await putSeeding(body);
    expect(out.status).toBe(400);
    expect(writes).toEqual([]);
    expect(generators.generateBracket).not.toHaveBeenCalled();
  });
});

describe("PUT /api/phases/:id/seeding — SEC-20 équipes du tournoi de la phase", () => {
  const FOREIGN = "6f1c2a6e-3b7d-4c8e-9f10-cccccccccccc";
  const withForeign = { participants: [{ team_id: TEAM_A, seed: 1 }, { team_id: FOREIGN, seed: 2 }] };

  it("SEC-20: équipe d'un autre tournoi du même serveur ➜ 400 sans RPC", async () => {
    teams.push({ id: FOREIGN, tournament_id: OTHER_TOURNAMENT_ID });
    const out = await putSeeding(withForeign);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Le placement contient une équipe qui n'est pas inscrite à ce tournoi." });
    expect(writes).toEqual([]);
    expect(generators.generateBracket).not.toHaveBeenCalled();
  });

  it("SEC-20: équipe d'un autre serveur (UUID inconnu du tournoi) ➜ 400 sans RPC, même message", async () => {
    const out = await putSeeding(withForeign);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Le placement contient une équipe qui n'est pas inscrite à ce tournoi." });
    expect(writes).toEqual([]);
  });

  it("SEC-20: toutes les équipes appartiennent au tournoi de la phase ➜ RPC appelé", async () => {
    const out = await putSeeding({ participants: [{ team_id: TEAM_A, seed: 1 }, { team_id: TEAM_C, seed: 2 }] });
    expect(out.status).toBe(200);
    expect(writes).toEqual(["rpc:regenerate_phase_seeding"]);
  });

  it("SEC-20: exception SQL P0001 levée par la RPC (défense en profondeur) ➜ traduite en 400 sans fuite d'information", async () => {
    db.rpc.mockResolvedValueOnce({
      error: { code: "P0001", message: "Une ou plusieurs équipes n'appartiennent pas au tournoi de la phase" },
    });
    const out = await putSeeding({ participants: [{ team_id: TEAM_A, seed: 1 }, { team_id: TEAM_C, seed: 2 }] });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Le placement contient une équipe qui n'est pas inscrite à ce tournoi." });
    expect(generators.generateBracket).not.toHaveBeenCalled();
  });

  it("SEC-20/SEC-19: échec de lecture des équipes ➜ 500 générique, aucune écriture", async () => {
    teamsReadError = { code: "XX000", message: "relation teams secret detail" };
    const out = await putSeeding(webBody);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    expect(writes).toEqual([]);
  });
});
