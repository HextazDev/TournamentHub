import { describe, it, expect } from "vitest";
import {
  GROUP_POINTS_DEFAULTS,
  GroupPointsSettingsSchema,
  resolveGroupPoints,
} from "@hub/shared";

describe("resolveGroupPoints — LB-03 barème par défaut des poules", () => {
  it("LB-03: settings vide {} ➜ 3 / 1 / 0 / 0", () => {
    expect(resolveGroupPoints({})).toEqual({
      points_win: 3,
      points_draw: 1,
      points_loss: 0,
      points_forfeit: 0,
    });
  });

  it("LB-03: settings null ou non-objet ➜ barème par défaut", () => {
    expect(resolveGroupPoints(null)).toEqual(GROUP_POINTS_DEFAULTS);
    expect(resolveGroupPoints(undefined)).toEqual(GROUP_POINTS_DEFAULTS);
    expect(resolveGroupPoints("garbage")).toEqual(GROUP_POINTS_DEFAULTS);
    expect(resolveGroupPoints([3, 1, 0, 0])).toEqual(GROUP_POINTS_DEFAULTS);
  });

  it("LB-03: valeurs vides, NaN, chaînes ou décimales ➜ repli clé par clé", () => {
    expect(
      resolveGroupPoints({ points_win: "", points_draw: Number.NaN, points_loss: "2", points_forfeit: 1.5 }),
    ).toEqual(GROUP_POINTS_DEFAULTS);
  });

  it("LB-03: settings partiels ➜ seules les clés absentes prennent la valeur par défaut", () => {
    expect(resolveGroupPoints({ points_win: 2 })).toEqual({
      points_win: 2,
      points_draw: 1,
      points_loss: 0,
      points_forfeit: 0,
    });
  });

  it("LB-04: barème personnalisé (y compris pénalité négative) conservé tel quel", () => {
    const custom = { points_win: 2, points_draw: 0, points_loss: 1, points_forfeit: -1 };
    expect(resolveGroupPoints(custom)).toEqual(custom);
  });

  it("LB-04: les autres clés de settings ne fuient pas dans le barème", () => {
    expect(resolveGroupPoints({ points_win: 4, bracket_reset: true })).toEqual({
      ...GROUP_POINTS_DEFAULTS,
      points_win: 4,
    });
  });

  it("LB-03: valeur hors bornes [-99, 99] ➜ valeur par défaut", () => {
    expect(resolveGroupPoints({ points_win: 100, points_forfeit: -100 })).toEqual(GROUP_POINTS_DEFAULTS);
  });
});

describe("GroupPointsSettingsSchema — PH-01 validation des points à l'écriture", () => {
  it("PH-01: accepte un barème valide et conserve les autres clés", () => {
    const parsed = GroupPointsSettingsSchema.safeParse({ points_win: 3, points_forfeit: -2, foo: "bar" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ points_win: 3, points_forfeit: -2, foo: "bar" });
  });

  it("PH-01: accepte des settings sans aucune clé de points (phases non-poules)", () => {
    expect(GroupPointsSettingsSchema.safeParse({ bracket_reset: true }).success).toBe(true);
  });

  it.each([
    ["chaîne vide", { points_win: "" }],
    ["chaîne numérique", { points_draw: "1" }],
    ["décimal", { points_loss: 0.5 }],
    ["null", { points_forfeit: null }],
    ["hors bornes", { points_win: 1000 }],
  ])("PH-01: rejette %s", (_label, settings) => {
    expect(GroupPointsSettingsSchema.safeParse(settings).success).toBe(false);
  });

  it("PH-01: rejette des settings qui ne sont pas un objet", () => {
    expect(GroupPointsSettingsSchema.safeParse("x").success).toBe(false);
    expect(GroupPointsSettingsSchema.safeParse(null).success).toBe(false);
  });
});
