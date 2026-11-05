import { describe, expect, it } from "vitest";
import { formatRoundName, isDiscordSnowflake } from "@hub/shared";

describe("isDiscordSnowflake (SEC-11 / ORG-04)", () => {
  it("valide les snowflakes Discord réels (17 à 20 chiffres)", () => {
    expect(isDiscordSnowflake("1491768695389950022")).toBe(true);
    expect(isDiscordSnowflake("12345678901234567")).toBe(true);
    expect(isDiscordSnowflake("12345678901234567890")).toBe(true);
  });

  it("rejette les slugs d'organisation, uuid et chaînes invalides", () => {
    expect(isDiscordSnowflake("inklings-arena")).toBe(false);
    expect(isDiscordSnowflake("6bad37e9-b4d1-4451-b6bf-ef13dff9cc31")).toBe(false);
    expect(isDiscordSnowflake("123")).toBe(false);
    expect(isDiscordSnowflake("")).toBe(false);
    expect(isDiscordSnowflake(null)).toBe(false);
    expect(isDiscordSnowflake(undefined)).toBe(false);
  });
});

describe("formatRoundName", () => {
  it("formate les rounds standards (Round Robin, Single Elim, Swiss)", () => {
    expect(formatRoundName(1, "SINGLE_ELIM", "fr")).toBe("Round 1");
    expect(formatRoundName(3, "ROUND_ROBIN", "en")).toBe("Round 3");
  });

  it("formate les rounds techniques de Double Élimination", () => {
    expect(formatRoundName(1, "DOUBLE_ELIM", "fr")).toBe("Winners - Round 1");
    expect(formatRoundName(2, "DOUBLE_ELIM", "fr")).toBe("Winners - Round 2");
    expect(formatRoundName(11, "DOUBLE_ELIM", "fr")).toBe("Losers - Round 1");
    expect(formatRoundName(12, "DOUBLE_ELIM", "fr")).toBe("Losers - Round 2");
    expect(formatRoundName(14, "DOUBLE_ELIM", "fr")).toBe("Losers - Round 4");
    expect(formatRoundName(21, "DOUBLE_ELIM", "fr")).toBe("Grande Finale");
    expect(formatRoundName(21, "DOUBLE_ELIM", "en")).toBe("Grand Final");
    expect(formatRoundName(22, "DOUBLE_ELIM", "fr")).toBe("Grande Finale (Reset)");
    expect(formatRoundName(22, "DOUBLE_ELIM", "en")).toBe("Grand Final (Reset)");
  });
});
