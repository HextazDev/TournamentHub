import { describe, it, expect } from "vitest";
import { MATCH_INITIAL_STATUS, STANDINGS_MATCH_STATUSES, isMatchStarted, type StandingsMatch } from "@hub/shared";

// Prédicat pur partagé (SCR-09) : testé sans aucun mock.

function match(status: string, team1_score: number | null = 0, team2_score: number | null = 0): StandingsMatch {
  return { team1_id: "a", team2_id: "b", team1_score, team2_score, status };
}

describe("isMatchStarted — SCR-09", () => {
  it("SCR-09: match réel PENDING 0-0 ou sans score ➜ non commencé", () => {
    expect(MATCH_INITIAL_STATUS).toBe("PENDING");
    expect(isMatchStarted(match("PENDING"))).toBe(false);
    expect(isMatchStarted(match("PENDING", null, null))).toBe(false);
  });

  it.each(["FF", "WAITING_VALIDATION", "CONTESTED", "IN_PROGRESS", "DISPUTED", "DSQ", "COMPLETED"])(
    "SCR-09: match réel %s à 0-0 ➜ commencé",
    (status) => {
      expect(isMatchStarted(match(status))).toBe(true);
    },
  );

  it("SCR-09: score non nul alors que le statut est encore PENDING ➜ commencé", () => {
    expect(isMatchStarted(match("PENDING", 1, 0))).toBe(true);
    expect(isMatchStarted(match("PENDING", 0, 2))).toBe(true);
  });

  it("SCR-09: tout statut terminé (classement) d'un match réel est vu comme commencé", () => {
    for (const status of STANDINGS_MATCH_STATUSES) {
      expect(isMatchStarted(match(status))).toBe(true);
    }
  });

  it("SCR-09: un BYE (une seule équipe) n'est jamais commencé", () => {
    expect(isMatchStarted({ team1_id: "a", team2_id: null, team1_score: 0, team2_score: 0, status: "BYE" })).toBe(false);
    expect(isMatchStarted({ team1_id: null, team2_id: "b", team1_score: 3, team2_score: 0, status: "COMPLETED" })).toBe(false);
    expect(isMatchStarted({ team1_id: null, team2_id: null, team1_score: 0, team2_score: 0, status: "PENDING" })).toBe(false);
  });
});
