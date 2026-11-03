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
import { GuildRegistryService, type GuildLike, type MemberLike } from "../services/GuildRegistryService";

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
      return Promise.resolve(responses[`${table}.${call.op}`] ?? { data: null, error: null });
    };
    const builder = {
      select: () => builder,
      insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), builder),
      update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
      upsert: (payload: unknown) => ((call.op = "upsert"), (call.payload = payload), builder),
      delete: () => ((call.op = "delete"), builder),
      eq: (col: string, val: unknown) => (call.filters.push(["eq", col, val]), builder),
      not: (col: string, _op: string, val: unknown) => (call.filters.push(["not", col, val]), builder),
      maybeSingle: result,
      then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => result().then(resolve, reject),
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
  it("DISC-07: un nouveau serveur est inséré avec son profil et la langue détectée", async () => {
    const calls = fakeSupabase({ "server_settings.select": { data: null, error: null } });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(true);
    const insert = calls.find((c) => c.op === "insert");
    expect(insert?.payload).toEqual({ guild_id: "g1", guild_name: "Guild One", guild_icon: "abc", bot_present: true, language: "en" });
  });

  it("DISC-07: un serveur connu met à jour son profil sans écraser la langue choisie", async () => {
    const calls = fakeSupabase({ "server_settings.select": { data: { guild_id: "g1" }, error: null } });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(true);
    const update = calls.find((c) => c.op === "update");
    expect(update?.payload).toEqual({ guild_name: "Guild One", guild_icon: "abc", bot_present: true });
    expect(update?.filters).toContainEqual(["eq", "guild_id", "g1"]);
  });

  it("DISC-07: une erreur Supabase (ex : colonne absente PGRST204) est journalisée et signalée, jamais ignorée", async () => {
    const pgError = { code: "PGRST204", message: "Could not find the 'language' column" };
    fakeSupabase({ "server_settings.select": { data: null, error: null }, "server_settings.insert": { data: null, error: pgError } });
    await expect(GuildRegistryService.registerGuild(guild([]))).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("g1"), pgError);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("GuildRegistryService.syncMemberAdmin", () => {
  it("DISC-08: un membre portant le rôle TO est enregistré comme TO_ROLE", async () => {
    const calls = fakeSupabase();
    await expect(GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { roles: ["to"] }), "to")).resolves.toBe(true);
    expect(calls.find((c) => c.op === "upsert")?.payload).toEqual({ guild_id: "g1", discord_id: "u1", reason: "TO_ROLE" });
  });

  it("DISC-08: un membre sans droit est retiré de guild_admins", async () => {
    const calls = fakeSupabase();
    await GuildRegistryService.syncMemberAdmin(guild([]), member("u1"), "to");
    const del = calls.find((c) => c.op === "delete");
    expect(del?.filters).toEqual([["eq", "guild_id", "g1"], ["eq", "discord_id", "u1"]]);
  });

  it("DISC-08: un échec d'écriture est journalisé et aucun succès n'est annoncé", async () => {
    const err = { message: "boom" };
    fakeSupabase({ "guild_admins.upsert": { data: null, error: err } });
    await expect(GuildRegistryService.syncMemberAdmin(guild([]), member("u1", { admin: true }), null)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("GuildRegistryService.syncGuildAdmins", () => {
  it("DISC-08: recalcule tous les admins avec le rôle TO courant et purge les anciens", async () => {
    const calls = fakeSupabase({ "server_settings.select": { data: { to_role_id: "to" }, error: null } });
    const members = [member("owner"), member("u-to", { roles: ["to"] }), member("u-manage", { manage: true }), member("u-none")];
    await expect(GuildRegistryService.syncGuildAdmins(guild(members))).resolves.toBe(true);

    const upsert = calls.find((c) => c.op === "upsert");
    expect(upsert?.payload).toEqual([
      { guild_id: "g1", discord_id: "owner", reason: "SERVER_OWNER" },
      { guild_id: "g1", discord_id: "u-to", reason: "TO_ROLE" },
      { guild_id: "g1", discord_id: "u-manage", reason: "MANAGE_GUILD" },
    ]);
    const del = calls.find((c) => c.op === "delete");
    expect(del?.filters).toEqual([["eq", "guild_id", "g1"], ["not", "discord_id", '("owner","u-to","u-manage")']]);
  });

  it("DISC-08: ne purge rien si la lecture des paramètres échoue", async () => {
    const calls = fakeSupabase({ "server_settings.select": { data: null, error: { message: "down" } } });
    await expect(GuildRegistryService.syncGuildAdmins(guild([member("owner")]))).resolves.toBe(false);
    expect(calls.some((c) => c.op === "delete" || c.op === "upsert")).toBe(false);
  });
});
