import { describe, it, expect } from "vitest";
import {
  extractPlayerRegisterTournamentId,
  injectTournamentInviteToken,
  isBotProxyPathAllowed,
} from "../botProxyAllowlist";

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
      "organizations",
      "organizations/splat-fr",
      "organizations/splat-fr/members",
      "organizations/splat-fr/members/123456789012345678",
      "organizations/splat-fr/tournaments/t1/staff",
      "organizations/splat-fr/tournaments/t1/staff/123456789012345678",
      "organizations/splat-fr/integrations",
      "organizations/splat-fr/integrations/DISCORD",
      "player/tournaments/t1/register",
      "player/tournaments/t1/checkin",
      "player/matches/m1/report-score",
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

describe("routes d'organisation et de joueurs ajoutées à l'audit #100", () => {
  it.each([
    "organizations/invites/accept",
    "organizations/org-a/transfer",
    "organizations/org-a/invites",
    "organizations/org-a/invites/i-1",
    "player/matches/m-1/contest-score",
    "tournaments/t-1/integrations/sync",
    "tournaments/t-1/invite-link",
  ])("relaie %s", (path) => {
    expect(isBotProxyPathAllowed(path)).toBe(true);
  });

  it.each(["discord/permissions", "webhook/team-update", "organizations/org-a/secrets"])("bloque %s", (path) => {
    expect(isBotProxyPathAllowed(path)).toBe(false);
  });
});

describe("WEB-01 / SEC-41: injection serveur du cookie httpOnly invite_token à l'inscription", () => {
  it("identifie uniquement POST player/tournaments/:id/register", () => {
    expect(extractPlayerRegisterTournamentId("POST", "player/tournaments/t-123/register")).toBe("t-123");
    expect(extractPlayerRegisterTournamentId("DELETE", "player/tournaments/t-123/register")).toBeNull();
    expect(extractPlayerRegisterTournamentId("POST", "player/tournaments/t-123/checkin")).toBeNull();
    expect(extractPlayerRegisterTournamentId("POST", "tournaments/t-123/settings")).toBeNull();
  });

  it("injecte invite_token depuis le cookie httpOnly sans écraser un jeton déjà fourni", () => {
    const body = JSON.stringify({ name: "Squid", captain_ingame_name: "A", captain_friend_code: "SW-1", members: [] });
    const injected = JSON.parse(injectTournamentInviteToken(body, "secret-cookie-token"));
    expect(injected).toMatchObject({ name: "Squid", invite_token: "secret-cookie-token" });

    const withExplicit = JSON.stringify({ name: "Squid", invite_token: "explicit-token" });
    expect(JSON.parse(injectTournamentInviteToken(withExplicit, "secret-cookie-token"))).toMatchObject({
      invite_token: "explicit-token",
    });

    expect(injectTournamentInviteToken(body, null)).toBe(body);
  });
});
