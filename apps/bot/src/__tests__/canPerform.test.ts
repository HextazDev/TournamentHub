import { describe, it, expect } from "vitest";
import {
  canPerform,
  GUILD_ACTIONS,
  AccessDeniedCodeSchema,
  GuildAccessSchema,
  GuildDirectoryReasonSchema,
  OrganizationSlugSchema,
  CreateOrganizationSchema,
  WebRegisterTeamSchema,
  WebReportScoreSchema,
  ReportScoreSchema,
  CreateTeamSchema,
  GenerateFakeTeamsSchema,
  PhaseSeedingSchema,
  MAX_OWNED_ORGANIZATIONS,
  type GuildAccess,
  type GuildAction,
  type OrganizationAccess,
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

describe("RFC 0001 (#97): OrganizationAccess, rôles natifs et schémas Web autonomes", () => {
  it("ORG_OWNER peut tout faire, y compris transférer la propriété et gérer les intégrations", () => {
    const owner: OrganizationAccess = { level: "ORGANIZATION", role: "ORG_OWNER", source: "NATIVE" };
    expect(canPerform(owner, "MANAGE_SERVER_SETTINGS")).toBe(true);
    expect(canPerform(owner, "MANAGE_ORG_SETTINGS")).toBe(true);
    expect(canPerform(owner, "MANAGE_INTEGRATIONS")).toBe(true);
    expect(canPerform(owner, "MANAGE_ORG_MEMBERS")).toBe(true);
    expect(canPerform(owner, "TRANSFER_OWNERSHIP")).toBe(true);
    expect(canPerform(owner, "CREATE_TOURNAMENT")).toBe(true);
    expect(canPerform(owner, "MANAGE_TOURNAMENT", "t1")).toBe(true);
  });

  it("SEC-38: le propriétaire du serveur Discord n'est jamais ORG_OWNER sans rôle natif", () => {
    const discordOwner: OrganizationAccess = { level: "SERVER", reason: "SERVER_OWNER" };
    expect(canPerform(discordOwner, "TRANSFER_OWNERSHIP")).toBe(false);
    expect(canPerform(discordOwner, "DELETE_ORGANIZATION")).toBe(false);
    expect(canPerform(discordOwner, "MANAGE_ORG_MEMBERS")).toBe(true);
    expect(canPerform(discordOwner, "MANAGE_INTEGRATIONS")).toBe(true);

    const nativeOwner: OrganizationAccess = { level: "SERVER", reason: "SERVER_OWNER", nativeRole: "ORG_OWNER", source: "NATIVE" };
    expect(canPerform(nativeOwner, "TRANSFER_OWNERSHIP")).toBe(true);
    expect(canPerform(nativeOwner, "DELETE_ORGANIZATION")).toBe(true);
  });

  it("ORG_ADMIN gère l'organisation et les intégrations mais ne transfère pas la propriété", () => {
    const admin: OrganizationAccess = { level: "ORGANIZATION", role: "ORG_ADMIN", source: "NATIVE" };
    expect(canPerform(admin, "MANAGE_SERVER_SETTINGS")).toBe(true);
    expect(canPerform(admin, "MANAGE_INTEGRATIONS")).toBe(true);
    expect(canPerform(admin, "MANAGE_ORG_MEMBERS")).toBe(true);
    expect(canPerform(admin, "TRANSFER_OWNERSHIP")).toBe(false);
    expect(canPerform(admin, "CREATE_TOURNAMENT")).toBe(true);
  });

  it("ORG_TO gère et crée des tournois mais ne touche pas aux paramètres ni aux intégrations de l'organisation", () => {
    const orgTo: OrganizationAccess = { level: "ORGANIZATION", role: "ORG_TO", source: "NATIVE" };
    expect(canPerform(orgTo, "CREATE_TOURNAMENT")).toBe(true);
    expect(canPerform(orgTo, "DELETE_TOURNAMENT")).toBe(true);
    expect(canPerform(orgTo, "MANAGE_TOURNAMENT", "t1")).toBe(true);
    expect(canPerform(orgTo, "MANAGE_TOURNAMENT_ROLES", "t1")).toBe(true);
    expect(canPerform(orgTo, "MANAGE_SERVER_SETTINGS")).toBe(false);
    expect(canPerform(orgTo, "MANAGE_ORG_SETTINGS")).toBe(false);
    expect(canPerform(orgTo, "MANAGE_INTEGRATIONS")).toBe(false);
    expect(canPerform(orgTo, "MANAGE_ORG_MEMBERS")).toBe(false);
    expect(canPerform(orgTo, "TRANSFER_OWNERSHIP")).toBe(false);
  });

  it("rôles par tournoi : TOURNAMENT_TO, STATISTICIAN et CASTER ont des permissions strictement bornées", () => {
    const staff: OrganizationAccess = {
      level: "TOURNAMENT",
      tournamentIds: ["t-to", "t-stat", "t-cast"],
      tournamentRoles: {
        "t-to": "TOURNAMENT_TO",
        "t-stat": "STATISTICIAN",
        "t-cast": "CASTER",
      },
    };
    expect(canPerform(staff, "MANAGE_TOURNAMENT", "t-to")).toBe(true);
    expect(canPerform(staff, "SCORE_MATCH", "t-to")).toBe(true);
    expect(canPerform(staff, "VIEW_PRIVATE_TOURNAMENT", "t-to")).toBe(true);

    expect(canPerform(staff, "MANAGE_TOURNAMENT", "t-stat")).toBe(false);
    expect(canPerform(staff, "SCORE_MATCH", "t-stat")).toBe(true);
    expect(canPerform(staff, "VIEW_PRIVATE_TOURNAMENT", "t-stat")).toBe(true);

    expect(canPerform(staff, "MANAGE_TOURNAMENT", "t-cast")).toBe(false);
    expect(canPerform(staff, "SCORE_MATCH", "t-cast")).toBe(false);
    expect(canPerform(staff, "VIEW_PRIVATE_TOURNAMENT", "t-cast")).toBe(true);
  });

  it("valide les slugs d'organisation et les schémas Web autonomes (SEC-27 / SEC-30)", () => {
    expect(MAX_OWNED_ORGANIZATIONS).toBe(5);
    expect(OrganizationSlugSchema.safeParse("splatoon-fr").success).toBe(true);
    expect(OrganizationSlugSchema.safeParse("-bad").success).toBe(false);
    expect(OrganizationSlugSchema.safeParse("ab").success).toBe(false);
    expect(CreateOrganizationSchema.safeParse({ name: "Splatoon FR", slug: "splatoon-fr" }).success).toBe(true);
    expect(
      WebRegisterTeamSchema.safeParse({
        name: "Inklings",
        captain_ingame_name: "Cap",
        captain_friend_code: "SW-1111-2222-3333",
        members: [],
      }).success,
    ).toBe(true);
    expect(WebReportScoreSchema.safeParse({ team1_score: 3, team2_score: 1 }).success).toBe(true);
    expect(WebReportScoreSchema.safeParse({ team1_score: -1, team2_score: 1 }).success).toBe(false);
  });

  it("valide les UUIDs des schémas partagés avec .safeParse() sans erreur runtime (TYP-01)", () => {
    const validUuid = "6f1c2a6e-3b7d-4c8e-9f10-112233445566";
    expect(ReportScoreSchema.safeParse({ match_id: validUuid, team1_score: 2, team2_score: 1 }).success).toBe(true);
    expect(ReportScoreSchema.safeParse({ match_id: "not-a-uuid", team1_score: 2, team2_score: 1 }).success).toBe(false);

    expect(
      CreateTeamSchema.safeParse({
        tournament_id: validUuid,
        name: "Inklings",
        captain_discord_id: "000000123456789012",
      }).success,
    ).toBe(true);
    expect(
      CreateTeamSchema.safeParse({
        tournament_id: "bad-uuid",
        name: "Inklings",
        captain_discord_id: "000000123456789012",
      }).success,
    ).toBe(false);

    expect(GenerateFakeTeamsSchema.safeParse({ tournament_id: validUuid, count: 4 }).success).toBe(true);
    expect(GenerateFakeTeamsSchema.safeParse({ tournament_id: "bad-uuid", count: 4 }).success).toBe(false);

    expect(
      PhaseSeedingSchema.safeParse({
        participants: [{ team_id: validUuid, seed: 1 }],
      }).success,
    ).toBe(true);
    expect(
      PhaseSeedingSchema.safeParse({
        participants: [{ team_id: "bad-uuid", seed: 1 }],
      }).success,
    ).toBe(false);
  });
});
