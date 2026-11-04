import { describe, it, expect } from "vitest";
import {
  canPerform,
  GUILD_ACTIONS,
  AccessDeniedCodeSchema,
  GuildAccessSchema,
  GuildDirectoryReasonSchema,
  type GuildAccess,
  type GuildAction,
} from "@hub/shared";

const server = (reason: "SERVER_OWNER" | "ADMINISTRATOR" | "MANAGE_GUILD" | "TO_ROLE"): GuildAccess => ({
  level: "SERVER",
  reason,
});

describe("canPerform (SEC-15 / SEC-16)", () => {
  it.each(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD"] as const)("%s peut tout faire", (reason) => {
    for (const action of GUILD_ACTIONS) {
      expect(canPerform(server(reason), action, "t1")).toBe(true);
    }
  });

  it("le rôle TO du serveur gère, crée et supprime les tournois", () => {
    const to = server("TO_ROLE");
    expect(canPerform(to, "CREATE_TOURNAMENT")).toBe(true);
    expect(canPerform(to, "MANAGE_TOURNAMENT", "t1")).toBe(true);
    expect(canPerform(to, "DELETE_TOURNAMENT", "t1")).toBe(true);
  });

  it("le rôle TO du serveur ne touche pas aux paramètres du serveur (dont to_role_id)", () => {
    expect(canPerform(server("TO_ROLE"), "MANAGE_SERVER_SETTINGS")).toBe(false);
  });

  it("un accès limité à un tournoi ne gère que ce tournoi", () => {
    const scoped: GuildAccess = { level: "TOURNAMENT", tournamentIds: ["t1"] };
    expect(canPerform(scoped, "MANAGE_TOURNAMENT", "t1")).toBe(true);
    expect(canPerform(scoped, "MANAGE_TOURNAMENT", "t2")).toBe(false);
    expect(canPerform(scoped, "MANAGE_TOURNAMENT")).toBe(false);
    expect(canPerform(scoped, "CREATE_TOURNAMENT")).toBe(false);
    expect(canPerform(scoped, "DELETE_TOURNAMENT", "t1")).toBe(false);
    expect(canPerform(scoped, "MANAGE_SERVER_SETTINGS")).toBe(false);
  });

  it("SEC-22: un TO de tournoi ne modifie pas les rôles de son tournoi (ni d'un autre)", () => {
    const scoped: GuildAccess = { level: "TOURNAMENT", tournamentIds: ["t1", "t2"] };
    expect(canPerform(scoped, "MANAGE_TOURNAMENT_ROLES", "t1")).toBe(false);
    expect(canPerform(scoped, "MANAGE_TOURNAMENT_ROLES", "t3")).toBe(false);
    expect(canPerform(scoped, "MANAGE_TOURNAMENT_ROLES")).toBe(false);
  });

  it.each(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD", "TO_ROLE"] as const)(
    "SEC-22: le niveau SERVER (%s) modifie les rôles d'un tournoi",
    (reason) => {
      expect(canPerform(server(reason), "MANAGE_TOURNAMENT_ROLES", "t1")).toBe(true);
    },
  );

  it("SEC-21: un accès TOURNAMENT sans aucun tournoi n'autorise rien", () => {
    const empty: GuildAccess = { level: "TOURNAMENT", tournamentIds: [] };
    for (const action of GUILD_ACTIONS) {
      expect(canPerform(empty, action, "t1")).toBe(false);
    }
  });

  it("refuse une action inconnue (fermé par défaut)", () => {
    expect(canPerform(server("SERVER_OWNER"), "DROP_EVERYTHING" as GuildAction)).toBe(false);
  });

  it("expose les motifs de refus attendus par le web", () => {
    expect(AccessDeniedCodeSchema.options).toEqual([
      "NOT_LOGGED_IN",
      "NOT_A_MEMBER",
      "NO_RIGHTS",
      "BOT_NOT_IN_GUILD",
      "CHECK_FAILED",
      "SERVER_SETTINGS_RESERVED",
      "SERVER_LEVEL_REQUIRED",
      "TOURNAMENT_ROLES_RESERVED",
      "CHANNEL_NOT_ACCESSIBLE",
    ]);
  });
});

describe("SEC-24: motif d'annuaire TOURNAMENT_TO_ROLE", () => {
  it("est un motif d'annuaire (guild_admins), jamais un motif d'accès SERVER", () => {
    expect(GuildDirectoryReasonSchema.parse("TOURNAMENT_TO_ROLE")).toBe("TOURNAMENT_TO_ROLE");
    expect(GuildDirectoryReasonSchema.options).toEqual(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD", "TO_ROLE", "TOURNAMENT_TO_ROLE"]);
    expect(GuildAccessSchema.safeParse({ level: "SERVER", reason: "TOURNAMENT_TO_ROLE" }).success).toBe(false);
  });
});
