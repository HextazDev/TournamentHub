import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";
import { DomainError } from "../utils/serverError";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));

vi.mock("../services/LeaderboardService", () => ({
  LeaderboardService: {
    calculateGroupStandings: vi.fn().mockResolvedValue(undefined),
  },
}));

import { RoundRobinGeneratorService } from "../services/RoundRobinGeneratorService";
import { LeaderboardService } from "../services/LeaderboardService";

function setupPhaseTeams(teams: { team_id: string; seed: number }[]) {
  db.current = new FakeSupabase({
    phase_teams: teams.map(t => ({ phase_id: "phase-1", ...t })),
    groups: [],
    matches: [],
  });
  return db.current;
}

describe("RoundRobinGeneratorService — Cas limites e-sport (RR-01 à RR-03, Berger)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("RR-01: Validation du nombre d'équipes vs groupes", () => {
    it("rejette avec DomainError(400) s'il y a moins d'équipes que de groupes demandés", async () => {
      setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
      ]);

      await expect(RoundRobinGeneratorService.generateGroups("phase-1", 3)).rejects.toThrow(DomainError);
      await expect(RoundRobinGeneratorService.generateGroups("phase-1", 3)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("Cannot create 3 groups with only 2 teams"),
      });
    });
  });

  describe("RR-02: Gestion des poules au nombre impair d'équipes & slots virtuels BYE", () => {
    it("ajoute un slot virtuel BYE (3 équipes ➜ 3 rondes, match contre BYE COMPLETED avec 1-0)", async () => {
      const fake = setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 1);

      const matches = fake.tables.matches ?? [];
      // 3 équipes + 1 BYE virtuel ➜ 4 slots ➜ 3 rondes de 2 matchs = 6 matchs au total
      expect(matches).toHaveLength(6);

      // Matchs réels vs matchs BYE
      const byeMatches = matches.filter(m => m.status === "COMPLETED");
      const pendingMatches = matches.filter(m => m.status === "PENDING");

      // Chaque ronde doit avoir exactement 1 match BYE et 1 match réel
      expect(byeMatches).toHaveLength(3);
      expect(pendingMatches).toHaveLength(3);

      // Tous les matchs BYE sont COMPLETED avec score 1-0 et team2_id null
      for (const m of byeMatches) {
        expect(m.status).toBe("COMPLETED");
        expect(m.team1_score).toBe(1);
        expect(m.team2_score).toBe(0);
        expect(m.team2_id).toBeNull();
      }

      // Chaque équipe reçoit exactement 1 BYE au cours des 3 rondes
      const byeTeams = byeMatches.map(m => m.team1_id).sort();
      expect(byeTeams).toEqual(["t1", "t2", "t3"]);
    });
  });

  describe("RR-03: Distribution des équipes en serpentin (snake seeding)", () => {
    it("répartit fidèlement les têtes de série en serpentin dans 2 groupes", async () => {
      const fake = setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
        { team_id: "t6", seed: 6 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 2);

      // Inspecter les affectations de groupe dans phase_teams
      const phaseTeams = fake.tables.phase_teams ?? [];
      const g1Teams = phaseTeams.filter(t => t.group_name === "Groupe 1").map(t => t.team_id).sort();
      const g2Teams = phaseTeams.filter(t => t.group_name === "Groupe 2").map(t => t.team_id).sort();

      // Serpentin pour 2 groupes :
      // G1 : 1, 4, 5
      // G2 : 2, 3, 6
      expect(g1Teams).toEqual(["t1", "t4", "t5"]);
      expect(g2Teams).toEqual(["t2", "t3", "t6"]);
    });

    it("répartit en serpentin dans 3 groupes", async () => {
      const fake = setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
        { team_id: "t6", seed: 6 },
        { team_id: "t7", seed: 7 },
        { team_id: "t8", seed: 8 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 3);

      const phaseTeams = fake.tables.phase_teams ?? [];
      const g1Teams = phaseTeams.filter(t => t.group_name === "Groupe 1").map(t => t.team_id).sort();
      const g2Teams = phaseTeams.filter(t => t.group_name === "Groupe 2").map(t => t.team_id).sort();
      const g3Teams = phaseTeams.filter(t => t.group_name === "Groupe 3").map(t => t.team_id).sort();

      // G1 : 1, 6, 7
      // G2 : 2, 5, 8
      // G3 : 3, 4
      expect(g1Teams).toEqual(["t1", "t6", "t7"]);
      expect(g2Teams).toEqual(["t2", "t5", "t8"]);
      expect(g3Teams).toEqual(["t3", "t4"]);
    });
  });

  describe("Algorithme du ruban (Berger) & Alternance domicile / extérieur", () => {
    it("génère toutes les confrontations uniques sans doublon ni match manquant (poule de 4)", async () => {
      const fake = setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 1);

      const matches = fake.tables.matches ?? [];
      // 4 équipes ➜ 3 rondes de 2 matchs = 6 matchs
      expect(matches).toHaveLength(6);

      // Vérifier que chaque paire d'équipes s'affronte exactement une fois
      const pairs = matches.map(m => [m.team1_id, m.team2_id].sort().join(" vs "));
      const expectedPairs = [
        "t1 vs t2",
        "t1 vs t3",
        "t1 vs t4",
        "t2 vs t3",
        "t2 vs t4",
        "t3 vs t4",
      ].sort();

      expect([...new Set(pairs)].sort()).toEqual(expectedPairs);
      expect(pairs).toHaveLength(6); // Aucun doublon
    });

    it("applique l'alternance domicile / extérieur pour l'équipe pivot (Berger)", async () => {
      const fake = setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 1);

      const matches = fake.tables.matches ?? [];
      const t1Matches = matches.filter(m => m.team1_id === "t1" || m.team2_id === "t1");
      expect(t1Matches).toHaveLength(3);

      // Trier par ronde
      t1Matches.sort((a, b) => (Number(a.round_number) || 0) - (Number(b.round_number) || 0));

      // Ronde 1 : t1 joue à domicile (team1_id === "t1")
      expect(t1Matches[0]!.round_number).toBe(1);
      expect(t1Matches[0]!.team1_id).toBe("t1");

      // Ronde 2 : t1 joue à l'extérieur (team2_id === "t1")
      expect(t1Matches[1]!.round_number).toBe(2);
      expect(t1Matches[1]!.team2_id).toBe("t1");

      // Ronde 3 : t1 joue à domicile (team1_id === "t1")
      expect(t1Matches[2]!.round_number).toBe(3);
      expect(t1Matches[2]!.team1_id).toBe("t1");
    });

    it("déclenche le recalcul des classements de groupe via LeaderboardService", async () => {
      setupPhaseTeams([
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
      ]);

      await RoundRobinGeneratorService.generateGroups("phase-1", 1);
      expect(LeaderboardService.calculateGroupStandings).toHaveBeenCalledTimes(1);
    });
  });
});
