import { describe, it, expect } from "vitest";
import { isBotProxyPathAllowed } from "../botProxyAllowlist";

describe("isBotProxyPathAllowed", () => {
  it("SEC-13: autorise les routes de gestion appelées par le back-office", () => {
    for (const path of [
      "discord/roles",
      "discord/channels",
      "discord/members",
      "server-settings",
      "tournaments",
      "tournaments/0b1c/settings",
      "tournaments/0b1c/registrations",
      "teams/abc/checkin",
      "teams/generate-fake",
      "phases/abc/seeding",
      "matches/abc/force-score",
    ]) {
      expect(isBotProxyPathAllowed(path), path).toBe(true);
    }
  });

  it("SEC-13: bloque les routes internes ou non protégées par requireGuildAdmin", () => {
    for (const path of [
      "discord/permissions",
      "discord/auto-setup",
      "discord/sync-schedule",
      "discord/publish-phase",
      "webhook/team-update",
      "tournaments/archive-and-init",
      "health",
      "../health",
      "teams/../../webhook/team-update",
      "",
    ]) {
      expect(isBotProxyPathAllowed(path), path).toBe(false);
    }
  });
});
