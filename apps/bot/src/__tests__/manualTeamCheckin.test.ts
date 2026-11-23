import { describe, expect, it } from "vitest";
import { defaultCheckedInOnManualAdd } from "../utils/manualTeamCheckin";

const NOW = new Date("2026-06-01T12:00:00Z");
const BEFORE = "2026-06-01T11:00:00Z";
const AFTER = "2026-06-01T13:00:00Z";

describe("defaultCheckedInOnManualAdd — REG-09 check-in par défaut d'une équipe ajoutée à la main", () => {
  it("REG-09: DRAFT ➜ non check-in", () => {
    expect(defaultCheckedInOnManualAdd({ status: "DRAFT", checkin_start_at: null }, NOW)).toBe(false);
  });

  it("REG-09: REGISTRATION avant l'ouverture du check-in ➜ non check-in", () => {
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: AFTER }, NOW)).toBe(false);
  });

  it("REG-09: REGISTRATION sans fenêtre de check-in ➜ non check-in", () => {
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: null }, NOW)).toBe(false);
  });

  it("REG-09: check-in ouvert (now >= checkin_start_at) ➜ check-in", () => {
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: BEFORE }, NOW)).toBe(true);
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: NOW.toISOString() }, NOW)).toBe(true);
  });

  it("REG-09: tournoi lancé ou terminé ➜ check-in", () => {
    for (const status of ["ACTIVE", "COMPLETED", "ARCHIVED"] as const) {
      expect(defaultCheckedInOnManualAdd({ status, checkin_start_at: null }, NOW)).toBe(true);
    }
  });

  it("REG-09: date de check-in illisible ➜ non check-in", () => {
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: "not-a-date" }, NOW)).toBe(false);
  });

  it("REG-09: checkin_mode === DISABLED ➜ toujours check-in (même en DRAFT ou sans date)", () => {
    expect(defaultCheckedInOnManualAdd({ status: "DRAFT", checkin_start_at: null, checkin_mode: "DISABLED" }, NOW)).toBe(true);
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: AFTER, checkin_mode: "DISABLED" }, NOW)).toBe(true);
    expect(defaultCheckedInOnManualAdd({ status: "REGISTRATION", checkin_start_at: null, checkin_mode: "DISABLED" }, NOW)).toBe(true);
  });
});
