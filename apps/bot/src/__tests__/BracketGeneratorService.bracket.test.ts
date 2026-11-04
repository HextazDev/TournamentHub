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

import { BracketGeneratorService } from "../services/BracketGeneratorService";

function setupPhase(
  format: "SINGLE_ELIM" | "DOUBLE_ELIM",
  teams: { team_id: string; seed: number | null }[],
  existingMatches: { id: string }[] = [],
) {
  db.current = new FakeSupabase({
    phases: [{ id: "phase-1", format }],
    phase_teams: teams.map(t => ({ phase_id: "phase-1", ...t })),
    matches: existingMatches.map(m => ({ phase_id: "phase-1", ...m })),
  });
  return db.current;
}

describe("BracketGeneratorService — Cas limites e-sport (BRK-01 à BRK-07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("BRK-01: Ordre de seeding standard (getStandardSeeds)", () => {
    it("génère les têtes de série standard pour 4, 8, 16 et 32 équipes", () => {
      expect(BracketGeneratorService.getStandardSeeds(4)).toEqual([1, 4, 2, 3]);
      expect(BracketGeneratorService.getStandardSeeds(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);

      const seeds16 = BracketGeneratorService.getStandardSeeds(16);
      expect(seeds16).toHaveLength(16);
      expect(seeds16[0]).toBe(1);
      expect(seeds16[1]).toBe(16);

      // Invariant e-sport : la somme de chaque paire au tour 1 vaut N + 1
      for (let i = 0; i < seeds16.length; i += 2) {
        expect(seeds16[i]! + seeds16[i + 1]!).toBe(17);
      }
    });
  });

  describe("BRK-02: BYEs asymétriques & puissances de 2 non parfaites (3, 5, 6, 7, 13 équipes)", () => {
    it("3 équipes en Single Elimination (taille arrondie à 4) ➜ Seed 1 avance en finale via BYE (1-0)", async () => {
      const fake = setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 3);
      expect(matches).toHaveLength(3); // 2 en R1 + 1 en R2 (Finale)

      const r1 = matches.filter(m => m.round_number === 1);
      const r2 = matches.filter(m => m.round_number === 2);
      expect(r1).toHaveLength(2);
      expect(r2).toHaveLength(1);

      // Match 1 : Seed 1 vs Seed 4 (BYE car absent)
      const byeMatch = r1.find(m => m.team1_id === "t1" || m.team2_id === "t1")!;
      expect(byeMatch.status).toBe("COMPLETED");
      expect(byeMatch.team1_id).toBe("t1");
      expect(byeMatch.team2_id).toBeNull();
      expect(byeMatch.team1_score).toBe(1);
      expect(byeMatch.team2_score).toBe(0);

      // Match 2 : Seed 2 vs Seed 3 (PENDING)
      const realMatch = r1.find(m => m.id !== byeMatch.id)!;
      expect(realMatch.status).toBe("PENDING");
      expect([realMatch.team1_id, realMatch.team2_id].sort()).toEqual(["t2", "t3"]);

      // Finale (R2) : Seed 1 est déjà qualifié dans l'un des slots grâce à la cascade BYE
      const finalMatch = r2[0]!;
      expect(finalMatch.status).toBe("PENDING");
      expect(finalMatch.team1_id).toBe("t1");
      expect(finalMatch.team2_id).toBeNull(); // en attente du vainqueur de Match 2
    });

    it("5 équipes en Single Elimination (taille arrondie à 8) ➜ 3 BYEs auto-résolus, t1 avance en demi", async () => {
      const fake = setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 5);
      expect(matches).toHaveLength(7); // 4 en R1 + 2 en R2 + 1 en R3

      const r1 = matches.filter(m => m.round_number === 1);
      const completedR1 = r1.filter(m => m.status === "COMPLETED");
      const pendingR1 = r1.filter(m => m.status === "PENDING");

      // 3 matchs de R1 ont un BYE : (1 vs 8), (2 vs 7), (3 vs 6)
      expect(completedR1).toHaveLength(3);
      // 1 seul match réel en R1 : (4 vs 5)
      expect(pendingR1).toHaveLength(1);
      expect([pendingR1[0]!.team1_id, pendingR1[0]!.team2_id].sort()).toEqual(["t4", "t5"]);
    });

    it("6 équipes en Single Elimination ➜ Seeds 1 et 2 exemptés de premier tour (BYE)", async () => {
      setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
        { team_id: "t6", seed: 6 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 6);
      const r1 = matches.filter(m => m.round_number === 1);
      const byeMatches = r1.filter(m => m.status === "COMPLETED");

      // Paires standard de 8 : (1,8) et (2,7) n'ont pas de seed 8 ni 7 ➜ BYEs
      expect(byeMatches).toHaveLength(2);
      const advancedTeams = byeMatches.map(m => m.team1_id).sort();
      expect(advancedTeams).toEqual(["t1", "t2"]);
    });

    it("7 équipes en Single Elimination ➜ Seed 1 uniquement reçoit un BYE", async () => {
      setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
        { team_id: "t6", seed: 6 },
        { team_id: "t7", seed: 7 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 7);
      const r1 = matches.filter(m => m.round_number === 1);
      const byeMatches = r1.filter(m => m.status === "COMPLETED");
      expect(byeMatches).toHaveLength(1);
      expect(byeMatches[0]!.team1_id).toBe("t1");
      expect(byeMatches[0]!.team1_score).toBe(1);
      expect(byeMatches[0]!.team2_score).toBe(0);
    });

    it("13 équipes en Single Elimination (taille arrondie à 16) ➜ 3 BYEs au R1", async () => {
      const teams = Array.from({ length: 13 }, (_, i) => ({
        team_id: `t${i + 1}`,
        seed: i + 1,
      }));
      setupPhase("SINGLE_ELIM", teams);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 13);
      expect(matches).toHaveLength(15); // 8 + 4 + 2 + 1

      const r1 = matches.filter(m => m.round_number === 1);
      const byeMatches = r1.filter(m => m.status === "COMPLETED");
      expect(byeMatches).toHaveLength(3); // seeds 14, 15, 16 absents
    });
  });

  describe("BRK-03: Match mort (les deux emplacements vides)", () => {
    it("match dont les deux emplacements sont vides ➜ marqué COMPLETED avec 0-0 sans propager de null", async () => {
      // 3 équipes placées dans un arbre de 8 : seeds 1, 4, 5
      // La moitié inférieure de l'arbre (seeds 2, 7, 3, 6) n'a QUE des emplacements vides !
      // Le match (3 vs 6) a les 2 équipes nulles ➜ dead match.
      setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t4", seed: 4 },
        { team_id: "t5", seed: 5 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 8);

      // Match mort (3 vs 6) en R1
      const deadR1Match = matches.find(
        m => m.round_number === 1 && m.team1_id === null && m.team2_id === null,
      );
      expect(deadR1Match).toBeDefined();
      expect(deadR1Match!.status).toBe("COMPLETED");
      expect(deadR1Match!.team1_score).toBe(0);
      expect(deadR1Match!.team2_score).toBe(0);

      // Le match mort ne doit pas propager une équipe null au match suivant
      const nextMatch = matches.find(m => m.id === deadR1Match!.next_match_winner_id);
      expect(nextMatch).toBeDefined();
      // Le match suivant a lui aussi ses 2 équipes nulles (car (2 vs 7) était aussi vide)
      // donc il est lui aussi auto-résolu COMPLETED 0-0
      expect(nextMatch!.status).toBe("COMPLETED");
      expect(nextMatch!.team1_score).toBe(0);
      expect(nextMatch!.team2_score).toBe(0);
    });
  });

  describe("BRK-04: Détection des têtes de série dupliquées (valeur absolue)", () => {
    it("rejette avec DomainError(409) si deux équipes partagent le même seed positif", async () => {
      setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 2 },
        { team_id: "t2", seed: 2 },
      ]);

      await expect(BracketGeneratorService.generateBracket("phase-1", 4)).rejects.toThrow(DomainError);
      await expect(BracketGeneratorService.generateBracket("phase-1", 4)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Duplicate seed 2"),
      });
    });

    it("rejette avec DomainError(409) si deux équipes partagent le même seed en valeur absolue (ex : 3 et -3)", async () => {
      setupPhase("DOUBLE_ELIM", [
        { team_id: "t1", seed: 3 },
        { team_id: "t2", seed: -3 },
      ]);

      await expect(BracketGeneratorService.generateBracket("phase-1", 4)).rejects.toThrow(DomainError);
      await expect(BracketGeneratorService.generateBracket("phase-1", 4)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Duplicate seed -3"),
      });
    });
  });

  describe("BRK-05: Rejet si des matchs existent déjà pour la phase", () => {
    it("rejette avec DomainError(409) si la table matches contient déjà des matchs", async () => {
      setupPhase(
        "SINGLE_ELIM",
        [
          { team_id: "t1", seed: 1 },
          { team_id: "t2", seed: 2 },
        ],
        [{ id: "existing-match-1" }],
      );

      await expect(BracketGeneratorService.generateBracket("phase-1", 2)).rejects.toThrow(DomainError);
      await expect(BracketGeneratorService.generateBracket("phase-1", 2)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Matches already exist for phase phase-1"),
      });
    });
  });

  describe("BRK-06 & BRK-07: Double Elimination, seed négatif et numérotation des rounds", () => {
    it("BRK-06: seed négatif placé directement en Losers Bracket Round 11, jamais en Winners Round 1", async () => {
      setupPhase("DOUBLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: -4 }, // démarre directement en Losers Bracket
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 4);

      // t4 ne doit PAS être dans les matchs de WB R1 (round_number = 1)
      const wbR1 = matches.filter(m => m.round_number === 1);
      const t4InWb = wbR1.some(m => m.team1_id === "t4" || m.team2_id === "t4");
      expect(t4InWb).toBe(false);

      // t4 doit être présent dans le Losers Bracket Round 11
      const lbR11 = matches.filter(m => m.round_number === 11);
      expect(lbR11.length).toBeGreaterThan(0);
      const t4InLb = lbR11.some(m => m.team1_id === "t4" || m.team2_id === "t4");
      expect(t4InLb).toBe(true);
    });

    it("BRK-06: en SINGLE_ELIM, un seed négatif est traité comme un seed positif", async () => {
      setupPhase("SINGLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: -2 }, // traité comme seed 2 en Single Elim
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 2);
      const r1 = matches.filter(m => m.round_number === 1);
      expect(r1).toHaveLength(1);
      expect([r1[0]!.team1_id, r1[0]!.team2_id].sort()).toEqual(["t1", "t2"]);
    });

    it("BRK-07: numérotation des rounds en Double Elimination (WB 1..log2(N), LB 11+, Grande Finale 21)", async () => {
      setupPhase("DOUBLE_ELIM", [
        { team_id: "t1", seed: 1 },
        { team_id: "t2", seed: 2 },
        { team_id: "t3", seed: 3 },
        { team_id: "t4", seed: 4 },
      ]);

      const matches = await BracketGeneratorService.generateBracket("phase-1", 4);

      // WB rounds pour N=4 : R1 (demi) et R2 (Winners Final)
      const wbRounds = [...new Set(matches.filter(m => m.round_number < 10).map(m => m.round_number))];
      expect(wbRounds.sort((a, b) => a - b)).toEqual([1, 2]);

      // LB rounds : R11 (round 11) et R12 (round 10 + 2*2 - 2 = 12, Losers Final)
      const lbRounds = [...new Set(matches.filter(m => m.round_number >= 10 && m.round_number < 20).map(m => m.round_number))];
      expect(lbRounds.sort((a, b) => a - b)).toEqual([11, 12]);

      // Grande Finale : Round 21
      const gfMatch = matches.find(m => m.round_number === 21);
      expect(gfMatch).toBeDefined();

      // Liaison Winners Final ➜ Grande Finale
      const wbFinal = matches.find(m => m.round_number === 2)!;
      expect(wbFinal.next_match_winner_id).toBe(gfMatch!.id);

      // Liaison Losers Final ➜ Grande Finale
      const lbFinal = matches.find(m => m.round_number === 12)!;
      expect(lbFinal.next_match_winner_id).toBe(gfMatch!.id);

      // Rétrogradation des perdants WB vers LB : les perdants de WB R1 vont en LB R11
      const wbR1 = matches.filter(m => m.round_number === 1);
      for (const m of wbR1) {
        expect(m.next_match_loser_id).toBeDefined();
        const targetLb = matches.find(lb => lb.id === m.next_match_loser_id);
        expect(targetLb).toBeDefined();
        expect(targetLb!.round_number).toBe(11);
      }
    });
  });
});
