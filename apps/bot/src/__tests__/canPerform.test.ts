import { describe, it, expect } from "vitest";
import { canPerform, GUILD_ACTIONS, AccessDeniedCodeSchema, type GuildAccess, type GuildAction } from "@hub/shared";

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
    ]);
  });
});
