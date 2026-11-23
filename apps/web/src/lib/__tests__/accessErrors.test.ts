import { describe, it, expect } from "vitest";
import { botAccessError, botInternalError, BOT_UNREACHABLE, relayedBotError } from "../accessErrors";
import { t } from "../../i18n";

describe("botAccessError (SEC-18) : erreurs d'accès traduites, jamais le texte brut du bot", () => {
  it.each(["NOT_LOGGED_IN", "NOT_A_MEMBER", "NO_RIGHTS", "BOT_NOT_IN_GUILD", "CHECK_FAILED", "SERVER_SETTINGS_RESERVED", "CHANNEL_NOT_ACCESSIBLE"] as const)(
    "traduit le code %s en FR et en EN",
    (code) => {
      const fr = botAccessError({ error: "Insufficient Discord permissions", code }, "fr");
      const en = botAccessError({ error: "Insufficient Discord permissions", code }, "en");
      expect(fr).toEqual({ error: t("fr", `access.${code}`), code });
      expect(en).toEqual({ error: t("en", `access.${code}`), code });
      expect(fr?.error).not.toBe(`access.${code}`);
      expect(fr?.error).not.toBe(en?.error);
    },
  );

  it("le refus du rôle TO sur les paramètres serveur est explicite", () => {
    expect(botAccessError({ code: "SERVER_SETTINGS_RESERVED" }, "fr")?.error).toMatch(/rôle TO/);
  });

  it("laisse passer les erreurs métier (sans code d'accès) telles quelles", () => {
    expect(botAccessError({ error: "Phase introuvable" }, "fr")).toBeNull();
    expect(botAccessError({ error: "x", code: "SOMETHING_ELSE" }, "fr")).toBeNull();
    expect(botAccessError("Bot returned 403", "fr")).toBeNull();
    expect(botAccessError(null, "fr")).toBeNull();
  });

  it("un bot injoignable devient CHECK_FAILED traduit", () => {
    expect(botAccessError(BOT_UNREACHABLE, "en")).toEqual({ error: t("en", "access.CHECK_FAILED"), code: "CHECK_FAILED" });
  });
});

describe("relayedBotError : corps d'erreur des proxys dédiés (plus de « Bot returned 403: … »)", () => {
  it("traduit un refus d'accès", () => {
    const raw = JSON.stringify({ error: "Insufficient Discord permissions", code: "NO_RIGHTS" });
    expect(relayedBotError(raw, "en")).toEqual({ error: t("en", "access.NO_RIGHTS"), code: "NO_RIGHTS" });
  });

  it("relaie le message métier JSON sans préfixe technique", () => {
    expect(relayedBotError(JSON.stringify({ error: "Phase introuvable" }), "fr")).toEqual({ error: "Phase introuvable" });
  });

  it("un corps vide, non JSON ou sans message donne un message générique traduit", () => {
    for (const raw of ["", "<html>502</html>", JSON.stringify({ foo: 1 })]) {
      expect(relayedBotError(raw, "fr"), raw).toEqual({ error: t("fr", "common.unknown") });
    }
  });
});

describe("botInternalError (SEC-19) : un échec serveur du bot devient un message générique traduit", () => {
  const body = { error: "Internal Server Error", code: "INTERNAL_ERROR" };

  it("SEC-19: traduit le code INTERNAL_ERROR en FR et en EN", () => {
    const fr = botInternalError(body, "fr");
    const en = botInternalError(body, "en");
    expect(fr).toEqual({ error: t("fr", "common.internalError") });
    expect(en).toEqual({ error: t("en", "common.internalError") });
    expect(fr?.error).not.toBe("common.internalError");
    expect(fr?.error).not.toBe(en?.error);
  });

  it("laisse passer les autres corps", () => {
    expect(botInternalError({ error: "Phase introuvable" }, "fr")).toBeNull();
    expect(botInternalError({ code: "NO_RIGHTS" }, "fr")).toBeNull();
    expect(botInternalError(null, "fr")).toBeNull();
  });

  it("SEC-19: relayedBotError remplace le texte générique anglais par le message traduit", () => {
    expect(relayedBotError(JSON.stringify(body), "fr")).toEqual({ error: t("fr", "common.internalError") });
  });
});
