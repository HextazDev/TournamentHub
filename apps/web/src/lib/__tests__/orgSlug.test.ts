import { describe, expect, it } from "vitest";
import { slugifyOrganizationName } from "../orgSlug";

describe("slugifyOrganizationName : auto-génération fiable du slug d'organisation", () => {
  it("convertit un nom classique en slug minuscule avec tirets", () => {
    expect(slugifyOrganizationName("Arena Esports FR")).toBe("arena-esports-fr");
  });

  it("normalise les accents et caractères spéciaux sans tronquer à la 1ère lettre", () => {
    expect(slugifyOrganizationName("Équipe Élite #1!")).toBe("equipe-elite-1");
  });

  it("borne le slug à 48 caractères max (aligné sur OrganizationSlugSchema) sans tiret final", () => {
    const longName = "Super Long Organization Name For Competitive Gaming Events 2026";
    const slug = slugifyOrganizationName(longName);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("renvoie une chaîne vide si le nom ne contient aucun caractère alphanumérique", () => {
    expect(slugifyOrganizationName("   !!!   ")).toBe("");
  });
});
