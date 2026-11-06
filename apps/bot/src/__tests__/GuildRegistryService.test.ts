import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { resolveAdminReason } from "../utils/adminAccess";
import {
  GuildRegistryService,
  readAdminRoles,
  type AdminRoles,
  type GuildLike,
  type MemberLike,
  type TournamentToRole,
} from "../services/GuildRegistryService";

type Result = { data: unknown; error: { code?: string; message: string } | null };
type Call = { table: string; op: string; payload?: unknown; filters: [string, string, unknown][] };

/**
 * Faux client Supabase : enregistre chaque opération (table, verbe, payload, filtres)
 * et renvoie la réponse programmée pour `table.op` (succès vide par défaut).
 */
function fakeSupabase(responses: Record<string, Result> = {}) {
  const calls: Call[] = [];
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const result = () => {
      if (!calls.includes(call)) calls.push(call);
      if (responses[`${table}.${call.op}`]) return Promise.resolve(responses[`${table}.${call.op}`]);
      if (table === "organization_integrations" && call.op === "select") {
        return Promise.resolve({
          data: { id: "int-1", organization_id: "org-1", provider: "DISCORD", external_id: "g1", enabled: true, config: {} },
          error: null,
        });
      }
      if (table === "organizations" && call.op === "select") {
        return Promise.resolve({
          data: { id: "org-1", slug: "discord-g1", name: "Guild One" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const builder = {
      select: () => builder,
      insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), builder),
      update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
      upsert: (payload: unknown) => ((call.op = "upsert"), (call.payload = payload), builder),
      delete: () => ((call.op = "delete"), builder),
      eq: (col: string, val: unknown) => (call.filters.push(["eq", col, val]), builder),
      neq: (col: string, val: unknown) => (call.filters.push(["neq", col, val]), builder),
      not: (col: string, _op: string, val: unknown) => (call.filters.push(["not", col, val]), builder),
      single: result,
      maybeSingle: result,
      then: (resolve?: (r: Result | undefined) => unknown, reject?: (e: unknown) => unknown) => result().then(resolve, reject),
    };
    return builder;
  }) as unknown as typeof supabase.from);
  return calls;
}

function member(id: string, opts: { admin?: boolean; manage?: boolean; roles?: string[] } = {}): MemberLike {
  return {
    id,
    user: { bot: false },
    permissions: {
      has: (flag: bigint) =>
        (flag === 8n && !!opts.admin) || (flag === 32n && !!opts.manage),
    },
    roles: { cache: { has: (roleId: string) => (opts.roles ?? []).includes(roleId) } },
  };
}

function guild(members: MemberLike[], ownerId = "owner"): GuildLike {
  return {
    id: "g1",
    name: "Guild One",
    icon: "abc",
    ownerId,
    preferredLocale: "en-US",
    members: { fetch: () => Promise.resolve(new Map(members.map((m) => [m.id, m]))) },
  };
}

beforeEach(() => vi.clearAllMocks());

const roles = (toRoleId: string | null, tournamentRoles: TournamentToRole[] = []): AdminRoles => ({ toRoleId, tournamentRoles });

describe("resolveAdminReason", () => {
  it("SEC-11: owner > Administrator > ManageGuild > TO role, sinon null", () => {
    const base = { isOwner: false, hasAdministrator: false, hasManageGuild: false, hasToRole: false };
    expect(resolveAdminReason({ ...base, isOwner: true, hasAdministrator: true })).toBe("SERVER_OWNER");
    expect(resolveAdminReason({ ...base, hasAdministrator: true, hasToRole: true })).toBe("ADMINISTRATOR");
    expect(resolveAdminReason({ ...base, hasManageGuild: true })).toBe("MANAGE_GUILD");
    expect(resolveAdminReason({ ...base, hasToRole: true })).toBe("TO_ROLE");
    expect(resolveAdminReason(base)).toBeNull();
  });
});

describe("GuildRegistryService.registerGuild", () => {
  it("DISC-07: un nouveau serveur est inséré avec son organisation et son intégration Discord", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: null, error: null },
      "organizations.insert": { data: { id: "org-1" }, error: null },
    });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(true);

    const orgInsert = calls.find((c) => c.table === "organizations" && c.op === "insert");
    expect(orgInsert?.payload).toEqual({
      slug: "discord-g1",
      name: "Guild One",
      icon_url: "abc",
      logo_url: "abc",
      language: "en",
    });

    const intInsert = calls.find((c) => c.table === "organization_integrations" && c.op === "insert");
    expect(intInsert?.payload).toEqual({
      organization_id: "org-1",
      provider: "DISCORD",
      type: "DISCORD",
      external_id: "g1",
      enabled: true,
      status: "CONNECTED",
      config: {
        guild_name: "Guild One",
        guild_icon: "abc",
        bot_present: true,
      },
    });
  });

  it("DISC-07: un serveur connu met à jour son profil sans écraser la langue choisie", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": {
        data: { id: "int-1", organization_id: "org-1", config: { to_role_id: "to" } },
        error: null,
      },
    });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(true);

    const orgUpdate = calls.find((c) => c.table === "organizations" && c.op === "update");
    expect(orgUpdate?.payload).toEqual({ name: "Guild One", icon_url: "abc", logo_url: "abc" });
    expect(orgUpdate?.filters).toContainEqual(["eq", "id", "org-1"]);

    const intUpdate = calls.find((c) => c.table === "organization_integrations" && c.op === "update");
    expect(intUpdate?.payload).toEqual({
      config: {
        to_role_id: "to",
        guild_name: "Guild One",
        guild_icon: "abc",
        bot_present: true,
      },
    });
    expect(intUpdate?.filters).toContainEqual(["eq", "id", "int-1"]);
  });

  it("DISC-07: une erreur Supabase est journalisée et signalée, jamais ignorée", async () => {
    const pgError = { code: "PGRST204", message: "Could not find the 'organizations' column" };
    fakeSupabase({
      "organization_integrations.select": { data: null, error: null },
      "organizations.insert": { data: null, error: pgError },
    });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("g1"), pgError);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("GuildRegistryService.markGuildLeft", () => {
  it("DISC-07: le départ du bot met à jour l'intégration Discord en DISCONNECTED", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": {
        data: { id: "int-1", enabled: true, config: { guild_name: "Guild One", bot_present: true } },
        error: null,
      },
    });
    await expect(GuildRegistryService.markGuildLeft("g1")).resolves.toBe(true);
    const update = calls.find((c) => c.table === "organization_integrations" && c.op === "update");
    expect(update?.payload).toEqual({
      enabled: false,
      status: "DISCONNECTED",
      config: { guild_name: "Guild One", bot_present: false, left_while_enabled: true },
    });
    expect(update?.filters).toContainEqual(["eq", "id", "int-1"]);
  });
});

describe("GuildRegistryService.syncMemberAdmin", () => {
  it("DISC-08: un membre portant le rôle TO est enregistré comme TO_ROLE", async () => {
    const calls = fakeSupabase();
    await expect(GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { roles: ["to"] }), roles("to"))).resolves.toBe(true);
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "upsert")?.payload).toMatchObject({
      organization_id: "org-1",
      provider: "DISCORD",
      user_id: "u1",
      scope_type: "ORGANIZATION",
      granted_role: "ORG_TO",
      reason: "TO_ROLE",
    });
  });

  it("DISC-08: un membre sans droit est retiré des accès", async () => {
    const calls = fakeSupabase();
    await GuildRegistryService.syncMemberAdmin(guild([]), member("u1"), roles("to"));
    const del = calls.find((c) => c.table === "integration_access_grants" && c.op === "delete");
    expect(del?.filters).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "provider", "DISCORD"],
      ["eq", "user_id", "u1"],
    ]);
  });

  it("DISC-08: un échec d'écriture est journalisé et aucun succès n'est annoncé", async () => {
    const err = { message: "boom" };
    fakeSupabase({ "integration_access_grants.upsert": { data: null, error: err } });
    await expect(GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { admin: true }), roles(null))).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("GuildRegistryService.syncGuildAdmins", () => {
  it("DISC-08: recalcule tous les admins avec le rôle TO courant et purge les anciens", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": {
        data: { id: "int-1", organization_id: "org-1", provider: "DISCORD", external_id: "g1", enabled: true, config: { to_role_id: "to" } },
        error: null,
      },
    });
    const members = [member("owner"), member("u-to", { roles: ["to"] }), member("u-manage", { manage: true }), member("u-none")];
    await expect(GuildRegistryService.syncGuildAdmins(guild(members))).resolves.toBe(true);

    const upsert = calls.find((c) => c.table === "integration_access_grants" && c.op === "upsert");
    expect(upsert?.payload).toEqual([
      expect.objectContaining({ organization_id: "org-1", provider: "DISCORD", user_id: "owner", reason: "SERVER_OWNER" }),
      expect.objectContaining({ organization_id: "org-1", provider: "DISCORD", user_id: "u-to", reason: "TO_ROLE" }),
      expect.objectContaining({ organization_id: "org-1", provider: "DISCORD", user_id: "u-manage", reason: "MANAGE_GUILD" }),
    ]);
    const del = calls.find((c) => c.table === "integration_access_grants" && c.op === "delete");
    expect(del?.filters).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "provider", "DISCORD"],
      ["not", "user_id", '("owner","u-to","u-manage")'],
    ]);
  });

  it("DISC-08: ne purge rien si la lecture des paramètres échoue", async () => {
    const calls = fakeSupabase({ "organization_integrations.select": { data: null, error: { message: "down" } } });
    await expect(GuildRegistryService.syncGuildAdmins(guild([member("owner")]))).resolves.toBe(false);
    expect(calls.some((c) => c.op === "delete" || c.op === "upsert")).toBe(false);
  });
});

describe("annuaire integration_access_grants : rôle TO de tournoi (#67, DISC-08 / SEC-24)", () => {
  const tRole = { tournamentId: "t1", roleId: "t-role" };

  it("un membre qui n'a que le rôle TO d'un tournoi est enregistré comme TOURNAMENT_TO_ROLE", async () => {
    const calls = fakeSupabase();
    await expect(GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { roles: ["t-role"] }), roles("to", [tRole]))).resolves.toBe(true);
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "upsert")?.payload).toMatchObject({
      organization_id: "org-1",
      provider: "DISCORD",
      user_id: "u1",
      scope_type: "TOURNAMENT",
      tournament_id: "t1",
      granted_role: "TOURNAMENT_TO",
      reason: "TOURNAMENT_TO_ROLE",
    });
  });

  it("le motif serveur l'emporte sur le rôle TO d'un tournoi", async () => {
    const calls = fakeSupabase();
    await GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { roles: ["t-role", "to"] }), roles("to", [tRole]));
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "upsert")?.payload).toMatchObject({
      scope_type: "ORGANIZATION",
      reason: "TO_ROLE",
    });
  });

  it("un membre qui perd le rôle du tournoi (ou dont le rôle a changé) est retiré", async () => {
    const calls = fakeSupabase();
    await GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { roles: ["t-role"] }), roles(null, [{ tournamentId: "t1", roleId: "new-role" }]));
    expect(calls.some((c) => c.table === "integration_access_grants" && c.op === "upsert")).toBe(false);
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "delete")?.filters).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "provider", "DISCORD"],
      ["eq", "user_id", "u1"],
    ]);
  });

  it("syncGuildAdmins inclut les TO de tournoi et purge ceux d'un tournoi archivé (absent de la lecture)", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": {
        data: { id: "int-1", organization_id: "org-1", provider: "DISCORD", external_id: "g1", enabled: true, config: { to_role_id: "to" } },
        error: null,
      },
      "tournaments.select": { data: [{ id: "t1", discord_to_role_id: "t-role" }], error: null },
    });
    const members = [member("owner"), member("u-t", { roles: ["t-role"] }), member("u-archived", { roles: ["old-role"] })];
    await expect(GuildRegistryService.syncGuildAdmins(guild(members))).resolves.toBe(true);
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "upsert")?.payload).toEqual([
      expect.objectContaining({ organization_id: "org-1", provider: "DISCORD", user_id: "owner", reason: "SERVER_OWNER" }),
      expect.objectContaining({ organization_id: "org-1", provider: "DISCORD", user_id: "u-t", reason: "TOURNAMENT_TO_ROLE", tournament_id: "t1" }),
    ]);
    expect(calls.find((c) => c.table === "integration_access_grants" && c.op === "delete")?.filters).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "provider", "DISCORD"],
      ["not", "user_id", '("owner","u-t")'],
    ]);
    // SEC-23 : seuls les tournois non archivés comptent.
    expect(calls.find((c) => c.table === "tournaments")?.filters).toContainEqual(["neq", "status", "ARCHIVED"]);
  });

  it("ne purge rien si la lecture des rôles de tournoi échoue", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "int-1", organization_id: "org-1", provider: "DISCORD", external_id: "g1", enabled: true, config: { to_role_id: "to" } }, error: null },
      "tournaments.select": { data: null, error: { message: "down" } },
    });
    await expect(GuildRegistryService.syncGuildAdmins(guild([member("owner")]))).resolves.toBe(false);
    expect(calls.some((c) => c.op === "delete" || c.op === "upsert")).toBe(false);
  });

  it("readAdminRoles renvoie le rôle TO du serveur et ceux des tournois", async () => {
    fakeSupabase({
      "organization_integrations.select": { data: { id: "int-1", organization_id: "org-1", provider: "DISCORD", external_id: "g1", enabled: true, config: { to_role_id: "to" } }, error: null },
      "tournaments.select": { data: [{ id: "t1", discord_to_role_id: "t-role" }], error: null },
    });
    await expect(readAdminRoles("g1")).resolves.toEqual({ ok: true, toRoleId: "to", tournamentRoles: [tRole] });
  });
});

describe("ACC-01 / SEC-02: enregistrement d'un serveur et propriété native", () => {
  const guildLike = { id: "g1", name: "Guild One", icon: null, ownerId: "owner-1", preferredLocale: "fr" } as unknown as GuildLike;

  it("ACC-01: une organisation auto-créée reçoit le propriétaire du serveur comme ORG_OWNER natif", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: null, error: null },
      "organizations.insert": { data: { id: "org-1" }, error: null },
      "organization_members.select": { data: [], error: null },
    });
    await expect(GuildRegistryService.registerGuild(guildLike)).resolves.toBe(true);
    const member = calls.find((c) => c.table === "organization_members" && c.op === "insert");
    expect(member?.payload).toMatchObject({ organization_id: "org-1", user_id: "owner-1", role: "ORG_OWNER" });
  });

  it("ACC-01: rattrape une organisation existante sans responsable natif", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", enabled: true, config: {} }, error: null },
      "organizations.select": { data: { id: "org-1", slug: "discord-g1" }, error: null },
      "organization_members.select": { data: [], error: null },
    });
    await GuildRegistryService.registerGuild(guildLike);
    expect(calls.find((c) => c.table === "organization_members" && c.op === "insert")?.payload).toMatchObject({ user_id: "owner-1", role: "ORG_OWNER" });
  });

  it("ACC-01: propriétaire au plafond ➜ responsable natif ORG_ADMIN plutôt qu'aucun", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", enabled: true, config: {} }, error: null },
      "organizations.select": { data: { id: "org-1", slug: "discord-g1" }, error: null },
      "organization_members.select": { data: [], error: null },
      "organization_members.insert": { data: null, error: { code: "HT001", message: "quota" } },
    });
    await GuildRegistryService.registerGuild(guildLike);
    const roles = calls.filter((c) => c.table === "organization_members" && c.op === "insert").map((c) => (c.payload as { role: string }).role);
    expect(roles).toEqual(["ORG_OWNER", "ORG_ADMIN"]);
  });

  it("SEC-02: un redémarrage ne réactive pas une intégration coupée par un administrateur", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", enabled: false, status: "DISCONNECTED", config: { bot_present: true } }, error: null },
      "organizations.select": { data: { id: "org-1", slug: "discord-g1" }, error: null },
      "organization_members.select": { data: [{ role: "ORG_OWNER" }], error: null },
    });
    await GuildRegistryService.registerGuild(guildLike);
    const update = calls.find((c) => c.table === "organization_integrations" && c.op === "update");
    expect(update?.payload).not.toHaveProperty("enabled", true);
    expect(update?.payload).not.toMatchObject({ status: "CONNECTED" });
  });

  it("SEC-02: le retour du bot réactive seulement une intégration active à son départ", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", enabled: false, status: "DISCONNECTED", config: { bot_present: false, left_while_enabled: true } }, error: null },
      "organizations.select": { data: { id: "org-1", slug: "discord-g1" }, error: null },
      "organization_members.select": { data: [{ role: "ORG_OWNER" }], error: null },
    });
    await GuildRegistryService.registerGuild(guildLike);
    const update = calls.find((c) => c.table === "organization_integrations" && c.op === "update");
    expect(update?.payload).toMatchObject({ enabled: true, status: "CONNECTED" });
  });

  it("une organisation Web liée garde son nom : seul le profil auto-créé suit le serveur", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", enabled: true, config: {} }, error: null },
      "organizations.select": { data: { id: "org-1", slug: "mon-asso" }, error: null },
      "organization_members.select": { data: [{ role: "ORG_OWNER" }], error: null },
    });
    await GuildRegistryService.registerGuild(guildLike);
    expect(calls.find((c) => c.table === "organizations" && c.op === "update")).toBeUndefined();
  });

  it("SEC-26: sur une intégration coupée, syncGuildAdmins n'écrit aucun grant et purge l'existant", async () => {
    const calls = fakeSupabase({
      "organization_integrations.select": { data: { id: "i1", organization_id: "org-1", external_id: "g1", enabled: false, config: {} }, error: null },
    });
    const member = { id: "m1", user: { bot: false }, permissions: { has: () => true }, roles: { cache: { has: () => false } } } as unknown as MemberLike;
    const withMembers = { ...guildLike, members: { fetch: async () => new Map([["m1", member]]) } } as unknown as GuildLike;
    await GuildRegistryService.syncGuildAdmins(withMembers);
    expect(calls.some((c) => c.table === "integration_access_grants" && c.op === "upsert")).toBe(false);
    expect(calls.some((c) => c.table === "integration_access_grants" && c.op === "delete")).toBe(true);
  });
});
