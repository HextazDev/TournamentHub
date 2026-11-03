import { describe, it, expect } from "vitest";
import {
  buildBotInviteUrl,
  canManageFromOAuth,
  canViewTournament,
  serverSetupChecklist,
  splitServers,
  tournamentNextStep,
} from "../accessRules";

describe("canViewTournament", () => {
  const members = new Set(["g1"]);

  it("SEC-10: un tournoi public est visible de tous, même sans connexion", () => {
    expect(canViewTournament({ guild_id: "g2", is_public: true }, "g2", new Set())).toBe(true);
  });

  it("SEC-10: un tournoi privé n'est visible que des membres de son serveur", () => {
    expect(canViewTournament({ guild_id: "g1", is_public: false }, "g1", members)).toBe(true);
    expect(canViewTournament({ guild_id: "g2", is_public: false }, "g2", members)).toBe(false);
    expect(canViewTournament({ guild_id: "g2", is_public: null }, "g2", members)).toBe(false);
  });

  it("SEC-10: une URL dont le serveur ne correspond pas au tournoi est refusée (même public)", () => {
    expect(canViewTournament({ guild_id: "g2", is_public: true }, "g1", members)).toBe(false);
  });
});

describe("canManageFromOAuth", () => {
  it("SEC-11: propriétaire, Administrateur ou Gérer le serveur", () => {
    expect(canManageFromOAuth({ owner: true, permissions: "0" })).toBe(true);
    expect(canManageFromOAuth({ owner: false, permissions: "8" })).toBe(true);
    expect(canManageFromOAuth({ owner: false, permissions: "32" })).toBe(true);
    expect(canManageFromOAuth({ owner: false, permissions: "2048" })).toBe(false);
  });
});

describe("serverSetupChecklist / serverCardState", () => {
  const complete = {
    to_role_id: "1",
    captain_role_id: "2",
    registration_channel_id: "3",
    announcement_channel_id: "4",
    checkin_channel_id: "5",
  };

  it("liste les réglages manquants dans l'ordre du guide", () => {
    const steps = serverSetupChecklist({ ...complete, to_role_id: null, checkin_channel_id: null });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["toRole", "checkinChannel"]);
  });

});

describe("splitServers", () => {
  const complete = {
    to_role_id: "1",
    captain_role_id: "2",
    registration_channel_id: "3",
    announcement_channel_id: "4",
    checkin_channel_id: "5",
  };
  const g = (id: string, perms = "0", owner = false) => ({ id, name: id, icon: null, owner, permissions: perms });

  it("Mes serveurs : tous les serveurs où l'on est membre ET où le bot est présent, sans condition de droits", () => {
    const settings = new Map([
      ["with-bot", { ...complete, bot_present: true }],
      ["bot-left", { ...complete, bot_present: false }],
    ]);
    const { memberServers } = splitServers([g("with-bot"), g("bot-left"), g("unknown")], settings, new Set());
    expect(memberServers.map((s) => s.id)).toEqual(["with-bot"]);
  });

  it("Panel : serveurs gérables (OAuth ou rôle TO), bot installé ou non, avec l'état à traiter", () => {
    const settings = new Map([
      ["ready", { ...complete, bot_present: true }],
      ["setup", { ...complete, to_role_id: null, bot_present: true }],
      ["left", { ...complete, bot_present: false }],
      ["member-only", { ...complete, bot_present: true }],
    ]);
    const { managedServers } = splitServers(
      [g("ready", "8"), g("setup", "0", true), g("left", "32"), g("no-bot", "8"), g("to-role"), g("member-only")],
      settings,
      new Set(["to-role"]),
    );
    expect(managedServers.map((s) => [s.guild.id, s.state])).toEqual([
      ["setup", "setup"],
      ["ready", "ready"],
      ["left", "install"],
      ["no-bot", "install"],
      ["to-role", "install"],
    ]);
  });
});

describe("tournamentNextStep", () => {
  const base = {
    status: "DRAFT",
    is_registration_open: false,
    checkin_start_at: null,
    checkin_end_at: null,
    discord_registration_channel_id: "1",
  } as const;

  it("guide dans l'ordre : réglages Discord, structure, inscriptions, dates, participants, lancement", () => {
    const ctx = { phasesCount: 0, teamsCount: 0, serverSetupComplete: false };
    expect(tournamentNextStep(base, ctx)).toBe("serverSetup");
    expect(tournamentNextStep({ ...base, discord_registration_channel_id: null }, { ...ctx, serverSetupComplete: true })).toBe("registrationChannel");
    expect(tournamentNextStep(base, { ...ctx, serverSetupComplete: true })).toBe("structure");
    expect(tournamentNextStep(base, { ...ctx, serverSetupComplete: true, phasesCount: 1 })).toBe("openRegistrations");
    const open = { ...base, is_registration_open: true };
    expect(tournamentNextStep(open, { ...ctx, serverSetupComplete: true, phasesCount: 1 })).toBe("checkinDates");
    const dated = { ...open, status: "REGISTRATION", checkin_start_at: "x", checkin_end_at: "y" } as const;
    expect(tournamentNextStep(dated, { ...ctx, serverSetupComplete: true, phasesCount: 1 })).toBe("waitParticipants");
    expect(tournamentNextStep(dated, { ...ctx, serverSetupComplete: true, phasesCount: 1, teamsCount: 2 })).toBe("placementAndLaunch");
    expect(tournamentNextStep({ ...dated, status: "ACTIVE" }, ctx)).toBe("runMatches");
    expect(tournamentNextStep({ ...dated, status: "COMPLETED" }, ctx)).toBeNull();
  });
});

describe("buildBotInviteUrl", () => {
  it("pré-sélectionne le serveur et ne demande pas la permission Administrateur", () => {
    const url = new URL(buildBotInviteUrl("123", "456"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("guild_id")).toBe("456");
    expect(url.searchParams.get("disable_guild_select")).toBe("true");
    expect(BigInt(url.searchParams.get("permissions") ?? "0") & BigInt(8)).toBe(BigInt(0));
  });
});
