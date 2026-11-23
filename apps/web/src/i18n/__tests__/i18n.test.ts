import { describe, it, expect } from "vitest";
import { t, getTranslationValue } from "../index";
import { fr } from "../locales/fr";
import { en } from "../locales/en";

describe("Internationalization (i18n) Module", () => {
  it("should retrieve translation values by dot notation path", () => {
    expect(getTranslationValue(fr, "common.loading")).toBe("Chargement...");
    expect(getTranslationValue(en, "common.loading")).toBe("Loading...");
    expect(getTranslationValue(fr, "home.heroTitleHighlight")).toBe("Splatoon");
  });

  it("should fallback to key if translation key does not exist", () => {
    // Clés volontairement hors du dictionnaire : on vérifie le repli à l'exécution, que le typage interdit à la compilation.
    // @ts-expect-error clé inexistante
    expect(t("fr", "nonexistent.key.path")).toBe("nonexistent.key.path");
    // @ts-expect-error clé inexistante
    expect(t("en", "another.missing.key")).toBe("another.missing.key");
  });

  it("should interpolate parameters into translation string", () => {
    const frResult = t("fr", "tournaments.teamsCount", { count: 8 });
    expect(frResult).toBe("8 Équipes (4 joueurs)");

    const enResult = t("en", "tournaments.teamsCount", { count: 8 });
    expect(enResult).toBe("8 Teams (4 players)");
  });

  it("should correctly translate navigation keys for French and English", () => {
    expect(t("fr", "nav.myServers")).toBe("Mes Organisations");
    expect(t("en", "nav.myServers")).toBe("My Organizations");

    expect(t("fr", "nav.loginDiscord")).toBe("Connexion Discord");
    expect(t("en", "nav.loginDiscord")).toBe("Discord Login");
  });

  it("should correctly translate admin lifecycle keys", () => {
    expect(t("fr", "admin.launchTournament")).toBe("Lancer le Tournoi");
    expect(t("en", "admin.launchTournament")).toBe("Launch Tournament");
  });
});

describe("Dictionary parity (fr / en)", () => {
  const leaves = (obj: object, prefix = ""): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.set(key, v);
      else for (const [ck, cv] of leaves(v as object, key)) out.set(ck, cv);
    }
    return out;
  };
  const placeholders = (s: string) => [...s.matchAll(/\{\{?(\w+)\}?\}/g)].map((m) => m[1]).sort();
  const frLeaves = leaves(fr);
  const enLeaves = leaves(en);

  it("I18N-PAR: every key uses the same {placeholders} in fr and en", () => {
    for (const [key, value] of frLeaves) {
      expect(placeholders(enLeaves.get(key) ?? ""), key).toEqual(placeholders(value));
    }
  });

  it("I18N-PAR: no translation is left empty", () => {
    for (const [key, value] of [...frLeaves, ...enLeaves]) {
      expect(value.trim(), key).not.toBe("");
    }
  });
});
