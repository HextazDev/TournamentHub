import { describe, it, expect } from "vitest";
import {
  GROUP_POINTS_DEFAULTS,
  compareStandings,
  computeStandings,
  isFinishedMatchStatus,
  type StandingsMatch,
  type TeamStanding,
} from "@hub/shared";

// Fonction pure partagée bot / web : testée sans aucun mock.

function match(
  team1_id: string | null,
  team2_id: string | null,
  team1_score: number | null,
  team2_score: number | null,
  status: string,
): StandingsMatch {
  return { team1_id, team2_id, team1_score, team2_score, status };
}

function standingOf(standings: Map<string, TeamStanding>, teamId: string): TeamStanding {
  const standing = standings.get(teamId);
  if (!standing) throw new Error(`Aucun classement pour ${teamId}`);
  return standing;
}

const EMPTY: TeamStanding = {
  played: 0, wins: 0, draws: 0, losses: 0, forfeits: 0,
  score_for: 0, score_against: 0, differential: 0, points: 0,
};

describe("computeStandings — calcul unique du classement (bot & web)", () => {
  it("toutes les équipes de la liste ont une ligne, même sans match joué", () => {
    const standings = computeStandings(["A", "B"], [], GROUP_POINTS_DEFAULTS);
    expect([...standings.keys()]).toEqual(["A", "B"]);
    expect(standingOf(standings, "A")).toEqual(EMPTY);
  });

  it("match COMPLETED : victoire, nul, défaite et différence de buts", () => {
    const standings = computeStandings(
      ["A", "B", "C"],
      [
        match("A", "B", 2, 0, "COMPLETED"),
        match("A", "C", 1, 1, "COMPLETED"),
        match("C", "B", 3, 1, "COMPLETED"),
      ],
      GROUP_POINTS_DEFAULTS,
    );
    expect(standingOf(standings, "A")).toEqual({
      played: 2, wins: 1, draws: 1, losses: 0, forfeits: 0,
      score_for: 3, score_against: 1, differential: 2, points: 4,
    });
    expect(standingOf(standings, "B")).toEqual({
      played: 2, wins: 0, draws: 0, losses: 2, forfeits: 0,
      score_for: 1, score_against: 5, differential: -4, points: 0,
    });
  });

  it("LB-05: FF ➜ forfait exclusif (le perdant prend un forfait et points_forfeit, pas de défaite)", () => {
    const points = { points_win: 3, points_draw: 1, points_loss: 1, points_forfeit: -2 };
    const standings = computeStandings(["A", "B"], [match("A", "B", 0, 3, "FF")], points);
    expect(standingOf(standings, "B")).toEqual({
      played: 1, wins: 1, draws: 0, losses: 0, forfeits: 0,
      score_for: 3, score_against: 0, differential: 3, points: 3,
    });
    expect(standingOf(standings, "A")).toEqual({
      played: 1, wins: 0, draws: 0, losses: 0, forfeits: 1,
      score_for: 0, score_against: 3, differential: -3, points: -2,
    });
  });

  it("LB-07: FF à égalité (0-0) ➜ double forfait, aucune victoire", () => {
    const points = { ...GROUP_POINTS_DEFAULTS, points_forfeit: -1 };
    const standings = computeStandings(["A", "B"], [match("A", "B", 0, 0, "FF")], points);
    for (const teamId of ["A", "B"]) {
      expect(standingOf(standings, teamId)).toEqual({ ...EMPTY, played: 1, forfeits: 1, points: -1 });
    }
  });

  it("LB-08: statut BYE (Suisse) ➜ victoire au barème points_win", () => {
    const points = { ...GROUP_POINTS_DEFAULTS, points_win: 2 };
    const standings = computeStandings(["A"], [match("A", null, 1, 0, "BYE")], points);
    expect(standingOf(standings, "A")).toEqual({
      played: 1, wins: 1, draws: 0, losses: 0, forfeits: 0,
      score_for: 1, score_against: 0, differential: 1, points: 2,
    });
  });

  it("LB-08: BYE de poule (COMPLETED, adversaire null) ➜ même victoire, adversaire null ignoré", () => {
    const standings = computeStandings(["A"], [match(null, "A", 0, 1, "COMPLETED")], GROUP_POINTS_DEFAULTS);
    expect(standingOf(standings, "A")).toEqual({
      played: 1, wins: 1, draws: 0, losses: 0, forfeits: 0,
      score_for: 1, score_against: 0, differential: 1, points: 3,
    });
    expect(standings.size).toBe(1);
  });

  it("statuts non terminés (PENDING, WAITING_VALIDATION, CONTESTED, DISPUTED, DSQ…) ignorés", () => {
    const statuses = ["PENDING", "IN_PROGRESS", "WAITING_VALIDATION", "CONTESTED", "DISPUTED", "DSQ"];
    const standings = computeStandings(
      ["A", "B"],
      statuses.map((status) => match("A", "B", 2, 1, status)),
      GROUP_POINTS_DEFAULTS,
    );
    expect(standingOf(standings, "A")).toEqual(EMPTY);
    expect(standingOf(standings, "B")).toEqual(EMPTY);
  });

  it("équipe hors liste (autre groupe) : seules les équipes listées sont créditées", () => {
    const standings = computeStandings(["A"], [match("A", "Z", 1, 0, "COMPLETED")], GROUP_POINTS_DEFAULTS);
    expect(standingOf(standings, "A").points).toBe(3);
    expect(standings.has("Z")).toBe(false);
  });

  it("scores null traités comme 0", () => {
    const standings = computeStandings(["A", "B"], [match("A", "B", null, null, "COMPLETED")], GROUP_POINTS_DEFAULTS);
    expect(standingOf(standings, "A")).toEqual({ ...EMPTY, played: 1, draws: 1, points: 1 });
  });

  it("LB-04: barème personnalisé appliqué à chaque issue", () => {
    const points = { points_win: 5, points_draw: 2, points_loss: 1, points_forfeit: -3 };
    const standings = computeStandings(
      ["A", "B", "C"],
      [
        match("A", "B", 1, 0, "COMPLETED"),
        match("B", "C", 1, 1, "COMPLETED"),
        match("C", "A", 2, 0, "FF"),
      ],
      points,
    );
    expect(standingOf(standings, "A").points).toBe(5 - 3);
    expect(standingOf(standings, "B").points).toBe(1 + 2);
    expect(standingOf(standings, "C").points).toBe(2 + 5);
  });
});

describe("compareStandings — ordre du classement", () => {
  it("points ➜ différence ➜ buts marqués", () => {
    const rows = [
      { id: "low", ...EMPTY, points: 1 },
      { id: "bp", ...EMPTY, points: 3, differential: 1, score_for: 4 },
      { id: "diff", ...EMPTY, points: 3, differential: 2, score_for: 2 },
      { id: "bp-low", ...EMPTY, points: 3, differential: 1, score_for: 1 },
    ];
    expect([...rows].sort(compareStandings).map((r) => r.id)).toEqual(["diff", "bp", "bp-low", "low"]);
  });
});

describe("isFinishedMatchStatus — match terminé (fin de ronde, classement)", () => {
  it.each(["COMPLETED", "FF", "BYE"])("SCR-08: %s ➜ terminé", (status) => {
    expect(isFinishedMatchStatus(status)).toBe(true);
  });

  it.each(["PENDING", "IN_PROGRESS", "WAITING_VALIDATION", "CONTESTED", "DISPUTED", "DSQ", ""])(
    "SCR-08: %s ➜ non terminé",
    (status) => {
      expect(isFinishedMatchStatus(status)).toBe(false);
    },
  );
});
