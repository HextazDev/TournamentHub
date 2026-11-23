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

const roundMatches = (fake: FakeSupabase, round: number) =>
  (fake.tables.matches ?? []).filter(m => m.phase_id === "phase-1" && m.round_number === round);

describe("SwissGeneratorService — Cas limites e-sport (SWS-01 à SWS-04, SWS-06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SWS-01: Validation du nombre minimum d'équipes au R1", () => {
    it("rejette avec une erreur explicite si la phase compte moins de 2 équipes", async () => {
      db.current = new FakeSupabase({
        phase_teams: [{ phase_id: "phase-1", team_id: "t1", seed: 1 }],
        matches: [],
      });

      await expect(SwissGeneratorService.generateFirstRound("phase-1")).rejects.toThrow(
        "Il faut au moins 2 équipes pour générer une ronde suisse.",
      );
    });

    it("rejette si des matchs existent déjà pour la phase", async () => {
      db.current = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", seed: 1 },
          { phase_id: "phase-1", team_id: "t2", seed: 2 },
        ],
        matches: [{ id: "m0", phase_id: "phase-1" }],
      });

      await expect(SwissGeneratorService.generateFirstRound("phase-1")).rejects.toThrow(
        "Des matchs existent déjà pour la phase phase-1.",
      );
    });
  });

  describe("SWS-02: Attribution du BYE au R1 (nombre impair d'équipes)", () => {
    it("attribue le match BYE à l'équipe au seed le plus faible (score 1-0, status BYE)", async () => {
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", seed: 1 },
          { phase_id: "phase-1", team_id: "t2", seed: 2 },
          { phase_id: "phase-1", team_id: "t3", seed: 3 },
          { phase_id: "phase-1", team_id: "t4", seed: 4 },
          { phase_id: "phase-1", team_id: "t5", seed: 5 }, // seed le plus faible
        ],
        matches: [],
      });
      db.current = fake;

      await SwissGeneratorService.generateFirstRound("phase-1");

      const r1 = roundMatches(fake, 1);
      expect(r1).toHaveLength(3); // 2 matchs normaux + 1 BYE

      const byeMatch = r1.find(m => m.team1_id === "t5");
      expect(byeMatch).toBeDefined();
      expect(byeMatch).toMatchObject({
        team1_id: "t5",
        team2_id: null,
        round_number: 1,
        status: "BYE",
        team1_score: 1,
        team2_score: 0,
      });

      // Les 4 autres équipes sont appariées 2 par 2 (1 vs 2, 3 vs 4)
      const normalMatches = r1.filter(m => m.status === "PENDING");
      expect(normalMatches).toHaveLength(2);
      expect(normalMatches[0]).toMatchObject({ team1_id: "t1", team2_id: "t2", status: "PENDING" });
      expect(normalMatches[1]).toMatchObject({ team1_id: "t3", team2_id: "t4", status: "PENDING" });
    });
  });

  describe("SWS-03: Attribution du BYE aux rondes suivantes (priorité sans BYE antérieur)", () => {
    it("attribue le BYE à l'équipe la moins bien classée n'ayant JAMAIS eu de BYE", async () => {
      // 5 équipes : t5 a eu le BYE au Round 1 (donc 3 pts, 1 win).
      // t4 a perdu son match au Round 1 (0 pt, 0 win).
      // Au Round 2, t4 est la moins bien classée sans BYE ➜ t4 doit recevoir le BYE !
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t2", points: 0, wins: 0 },
          { phase_id: "phase-1", team_id: "t3", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t4", points: 0, wins: 0 }, // 0 pt, pas de BYE
          { phase_id: "phase-1", team_id: "t5", points: 3, wins: 1 }, // a eu le BYE en R1
        ],
        matches: [
          { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
          { id: "m2", phase_id: "phase-1", round_number: 1, team1_id: "t3", team2_id: "t4", status: "COMPLETED" },
          { id: "m3", phase_id: "phase-1", round_number: 1, team1_id: "t5", team2_id: null, status: "BYE" },
        ],
      });
      db.current = fake;

      const generated = await SwissGeneratorService.generateNextRound("phase-1", 2);
      expect(generated).toBe(true);

      const r2 = roundMatches(fake, 2);
      expect(r2).toHaveLength(3); // 2 matchs + 1 BYE

      const byeMatchR2 = r2.find(m => m.status === "BYE");
      expect(byeMatchR2).toBeDefined();
      // Le BYE doit aller à une équipe n'ayant jamais eu de BYE (t2 ou t4, les moins bien classées)
      expect(["t2", "t4"]).toContain(byeMatchR2!.team1_id);
      expect(byeMatchR2!.team1_id).not.toBe("t5");
    });

    it("SWS-03 repli : si toutes les équipes ont déjà eu un BYE, la dernière équipe prend le BYE", async () => {
      // 3 équipes où chacune a déjà eu un BYE
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", points: 6, wins: 2 },
          { phase_id: "phase-1", team_id: "t2", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t3", points: 3, wins: 1 },
        ],
        matches: [
          { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: null, status: "BYE" },
          { id: "m2", phase_id: "phase-1", round_number: 2, team1_id: "t2", team2_id: null, status: "BYE" },
          { id: "m3", phase_id: "phase-1", round_number: 3, team1_id: "t3", team2_id: null, status: "BYE" },
        ],
      });
      db.current = fake;

      const generated = await SwissGeneratorService.generateNextRound("phase-1", 4);
      expect(generated).toBe(true);

      const r4 = roundMatches(fake, 4);
      const byeMatch = r4.find(m => m.status === "BYE");
      expect(byeMatch).toBeDefined();
      // t3 est la dernière équipe classée, elle prend le repli BYE
      expect(byeMatch!.team1_id).toBe("t3");
    });
  });

  describe("SWS-04: Score group pairing & règle anti-rematch", () => {
    it("apparie les équipes par groupe de points et évite les revanches (anti-rematch)", async () => {
      // 4 équipes au Round 1 :
      // Match 1 : t1 (victoire) vs t2 (défaite)
      // Match 2 : t3 (victoire) vs t4 (défaite)
      // Groupes de points pour le Round 2 :
      // Groupe 3 pts : [t1, t3]
      // Groupe 0 pt  : [t2, t4]
      const fake = new FakeSupabase({
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
      db.current = fake;

      const generated = await SwissGeneratorService.generateNextRound("phase-1", 2);
      expect(generated).toBe(true);

      const r2 = roundMatches(fake, 2);
      expect(r2).toHaveLength(2);

      // t1 doit affronter t3 (même groupe 3 pts, jamais affrontés)
      const matchWinners = r2.find(m => m.team1_id === "t1" || m.team2_id === "t1")!;
      expect([matchWinners.team1_id, matchWinners.team2_id].sort()).toEqual(["t1", "t3"]);

      // t2 doit affronter t4 (même groupe 0 pt, jamais affrontés)
      const matchLosers = r2.find(m => m.team1_id === "t2" || m.team2_id === "t2")!;
      expect([matchLosers.team1_id, matchLosers.team2_id].sort()).toEqual(["t2", "t4"]);
    });

    it("SWS-04 repli : autorise la revanche si aucun adversaire inédit n'est disponible (pas de blocage)", async () => {
      // 2 équipes seulement : elles ont déjà joué l'une contre l'autre en R1.
      // En R2, t1 n'a pas d'autre adversaire que t2. Le générateur doit replier sans planter.
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t2", points: 0, wins: 0 },
        ],
        matches: [
          { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
        ],
      });
      db.current = fake;

      const generated = await SwissGeneratorService.generateNextRound("phase-1", 2);
      expect(generated).toBe(true);

      const r2 = roundMatches(fake, 2);
      expect(r2).toHaveLength(1);
      expect([r2[0]!.team1_id, r2[0]!.team2_id].sort()).toEqual(["t1", "t2"]);
    });

    it("SCR-08: non-blocage de la ronde suivante en présence d'un match forfait FF", async () => {
      // R1 contient un match terminé par forfait FF
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t2", points: 0, wins: 0 },
          { phase_id: "phase-1", team_id: "t3", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t4", points: 0, wins: 0 },
        ],
        matches: [
          { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
          { id: "m2", phase_id: "phase-1", round_number: 1, team1_id: "t3", team2_id: "t4", status: "FF" }, // Forfait !
        ],
      });
      db.current = fake;

      const generated = await SwissGeneratorService.generateNextRound("phase-1", 2);
      expect(generated).toBe(true);
      expect(roundMatches(fake, 2)).toHaveLength(2);
    });
  });

  describe("SWS-06: Idempotence & anti-doublon", () => {
    it("appelé deux fois pour la même ronde ➜ une seule génération", async () => {
      const fake = new FakeSupabase({
        phase_teams: [
          { phase_id: "phase-1", team_id: "t1", points: 3, wins: 1 },
          { phase_id: "phase-1", team_id: "t2", points: 0, wins: 0 },
        ],
        matches: [
          { id: "m1", phase_id: "phase-1", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
        ],
      });
      db.current = fake;

      const first = await SwissGeneratorService.generateNextRound("phase-1", 2);
      const second = await SwissGeneratorService.generateNextRound("phase-1", 2);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(roundMatches(fake, 2)).toHaveLength(1);
      expect(fake.writesTo("matches", "insert")).toHaveLength(1);
    });
  });
});
