import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const orgRpc = vi.hoisted(() => ({ error: null as { code: string; message: string } | null }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.rpc(name, args);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));

import { organizationRouter } from "../routes/OrganizationRouter";
import { clearMemberAccessCache, resolveMemberAccess } from "../services/MemberAccessService";
import { resetAccessRefreshState } from "../services/AccessRefreshService";
import { callRoute } from "./helpers/route";

const ORG_1 = "00000000-0000-0000-0000-000000000011";
const ORG_2 = "00000000-0000-0000-0000-000000000022";
const GUILD_1 = "111111111111111111";
const GUILD_NEW = "222222222222222222";

/** Faux client Discord : `caller` possède les droits demandés sur le serveur attendu (GUILD_NEW par défaut). */
function discordClient(caller: { id: string; manage: boolean } | null, allowedGuildId = GUILD_NEW) {
  return {
    guilds: {
      fetch: (guildId: string) =>
        guildId !== allowedGuildId || !caller
          ? Promise.reject(new Error("Unknown Guild"))
          : Promise.resolve({
              id: guildId,
              name: "New Guild",
              icon: null,
              ownerId: "someone-else",
              members: {
                fetch: (userId: string) =>
                  userId === caller.id
                    ? Promise.resolve({ permissions: { has: () => caller.manage }, roles: { cache: { has: () => false } } })
                    : Promise.reject(new Error("Unknown Member")),
              },
            }),
    },
  };
}

afterEach(() => {
  resetAccessRefreshState();
});

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberAccessCache();
  resetAccessRefreshState();
  orgRpc.error = null;
  db.current = new FakeSupabase({
    organizations: [
      { id: ORG_1, slug: "splatoon-fr", name: "Splatoon FR", language: "fr" },
      { id: ORG_2, slug: "other-org", name: "Other Org", language: "en" },
    ],
    organization_members: [
      { organization_id: ORG_1, user_id: "u-owner", role: "ORG_OWNER" },
      { organization_id: ORG_1, user_id: "u-admin", role: "ORG_ADMIN" },
      { organization_id: ORG_1, user_id: "u-to", role: "ORG_TO" },
      { organization_id: ORG_2, user_id: "u-owner-2", role: "ORG_OWNER" },
    ],
    organization_integrations: [
      {
        id: "int-1",
        organization_id: ORG_1,
        provider: "DISCORD",
        external_id: GUILD_1,
        enabled: true,
        status: "CONNECTED",
        config: { to_role_id: "role-to" },
      },
    ],
    organization_integration_secrets: [],
    integration_access_grants: [],
    tournaments: [],
    tournament_staff: [],
    organization_invites: [],
    tournament_invite_tokens: [],
  });
  // Simule les RPC SQL : leur atomicité et leurs quotas réels sont prouvés par supabase/tests/rls_access.sql.
  db.current.rpcHandler = (name, args) => {
    if (orgRpc.error) return { data: null, error: orgRpc.error };
    if (name === "create_organization_with_owner") {
      const owned = db.current!.tables.organization_members!.filter((m) => m.user_id === args.p_owner_id && m.role === "ORG_OWNER");
      if (owned.length >= 5) return { data: null, error: { code: "HT001", message: "quota" } };
      const row = { id: "00000000-0000-0000-0000-0000000000aa", slug: args.p_slug, name: args.p_name, language: args.p_language };
      db.current!.tables.organizations!.push(row);
      db.current!.tables.organization_members!.push({ organization_id: row.id, user_id: args.p_owner_id, role: "ORG_OWNER" });
      return { data: row, error: null };
    }
    if (name === "transfer_organization_ownership") {
      const members = db.current!.tables.organization_members!;
      const target = members.find((m) => m.organization_id === args.p_organization_id && m.user_id === args.p_to_user_id && m.role === "ORG_ADMIN");
      if (!target) return { data: null, error: { code: "HT004", message: "not admin" } };
      target.role = "ORG_OWNER";
      if (args.p_demote_self) {
        members.find((m) => m.organization_id === args.p_organization_id && m.user_id === args.p_from_user_id)!.role = "ORG_ADMIN";
      }
      return { data: null, error: null };
    }
    if (name === "accept_organization_invite") {
      const invite = db.current!.tables.organization_invites!.find((i) => i.token_hash === args.p_token_hash && !i.used_at);
      if (!invite) return { data: null, error: { code: "HT003", message: "invalid" } };
      invite.used_at = "now";
      return { data: [{ organization_id: invite.organization_id, slug: "splatoon-fr", role: invite.role, tournament_id: null }], error: null };
    }
    return { data: null, error: null };
  };
});

describe("POST /api/organizations — Création d'organisation sans Discord & Quota SEC-27", () => {
  it("crée une organisation 100 % Web et attribue ORG_OWNER au créateur", async () => {
    const out = await callRoute(organizationRouter, {
      method: "POST",
      path: "/",
      headers: { "x-discord-user-id": "u-new" },
      body: { name: "Inkopolis Cup", slug: "inkopolis-cup", language: "fr" },
    });

    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ name: "Inkopolis Cup", slug: "inkopolis-cup", language: "fr" });
    const members = db.current?.tables.organization_members?.filter((m) => m.user_id === "u-new");
    expect(members).toHaveLength(1);
    expect(members?.[0]?.role).toBe("ORG_OWNER");
  });

  it("SEC-27: refuse la création d'une 6e organisation en tant que ORG_OWNER (plafond de 5)", async () => {
    for (let i = 1; i <= 5; i++) {
      db.current?.tables.organization_members?.push({
        organization_id: `00000000-0000-0000-0000-00000000010${i}`,
        user_id: "u-serial-owner",
        role: "ORG_OWNER",
      });
    }

    const out = await callRoute(organizationRouter, {
      method: "POST",
      path: "/",
      headers: { "x-discord-user-id": "u-serial-owner" },
      body: { name: "Sixième Org", slug: "sixieme-org" },
    });

    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

describe("SEC-27: Gestion des membres natifs et protection du dernier ORG_OWNER", () => {
  it("interdit de supprimer ou rétrograder le dernier ORG_OWNER de l'organisation", async () => {
    const delOut = await callRoute(organizationRouter, {
      method: "DELETE",
      path: `/${ORG_1}/members/u-owner`,
      headers: { "x-discord-user-id": "u-owner" },
    });
    expect(delOut.status).toBe(400);

    const demoteOut = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/members`,
      headers: { "x-discord-user-id": "u-owner" },
      body: { user_id: "u-owner", role: "ORG_ADMIN" },
    });
    expect(demoteOut.status).toBe(400);
  });

  it("interdit à un ORG_ADMIN de nommer un ORG_OWNER (réservé à TRANSFER_OWNERSHIP)", async () => {
    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/members`,
      headers: { "x-discord-user-id": "u-admin" },
      body: { user_id: "u-admin", role: "ORG_OWNER" },
    });
    expect(out.status).toBe(403);
  });
});

describe("SEC-26 / SEC-28 / SEC-29: Gestion des intégrations et secrets", () => {
  it("SEC-29: refuse de rattacher un serveur Discord (external_id) déjà lié à une autre organisation", async () => {
    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_2}/integrations/DISCORD`,
      headers: { "x-discord-user-id": "u-owner-2" },
      body: { provider: "DISCORD", external_id: GUILD_1, enabled: true },
    });
    expect(out.status).toBe(409);
  });

  it("SEC-28: chiffre secret_payload en AES-256-GCM dans organization_integration_secrets sans jamais le renvoyer en JSON", async () => {
    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/AI`,
      headers: { "x-discord-user-id": "u-owner" },
      body: {
        provider: "AI",
        enabled: true,
        config: { model: "gemini-2.5-flash" },
        secret_payload: "sk-super-secret-ai-key",
      },
    });

    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).not.toContain("sk-super-secret-ai-key");
    expect(out.body).toMatchObject({ provider: "AI", enabled: true, has_secret: true });

    const secretRow = db.current?.tables.organization_integration_secrets?.[0];
    expect(secretRow).toBeDefined();
    expect(String(secretRow?.encrypted_payload)).toMatch(/^v1:/);
    expect(String(secretRow?.encrypted_payload)).not.toContain("sk-super-secret-ai-key");
  });

  it("SEC-26: désactiver l'intégration Discord invalide le cache et révoque les accès Discord sans bloquer ORG_OWNER", async () => {
    const fakeDiscord = {
      guilds: {
        fetch: () =>
          Promise.resolve({
            ownerId: "other",
            members: {
              fetch: () =>
                Promise.resolve({
                  permissions: { has: () => false },
                  roles: { cache: { has: (r: string) => r === "role-to" } },
                }),
            },
          }),
      },
    };

    // Avant désactivation : le TO Discord est en cache avec accès autorisé
    const before = await resolveMemberAccess(fakeDiscord, "splatoon-fr", "u-discord-only");
    expect(before.allowed).toBe(true);

    // Désactivation via la route PUT /:orgId/integrations/DISCORD
    const disableRes = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/DISCORD`,
      headers: { "x-discord-user-id": "u-owner" },
      body: { provider: "DISCORD", enabled: false },
    });
    expect(disableRes.status).toBe(200);

    // Immédiatement après : le TO Discord est révoqué sans attendre le TTL, et ORG_OWNER garde son accès
    const after = await resolveMemberAccess(fakeDiscord, "splatoon-fr", "u-discord-only");
    expect(after).toEqual({ allowed: false, code: "NO_RIGHTS" });

    const ownerAccess = await resolveMemberAccess(fakeDiscord, "splatoon-fr", "u-owner");
    expect(ownerAccess.allowed).toBe(true);
  });

  it("GET /:orgId expose les propriétés de l'organisation à la racine ainsi que sous organization (ARC-01)", async () => {
    const out = await callRoute(organizationRouter, {
      method: "GET",
      path: `/${ORG_1}`,
      headers: { "x-discord-user-id": "u-owner" },
    });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      id: ORG_1,
      slug: "splatoon-fr",
      language: "fr",
      discordEnabled: true,
      discordConfig: { to_role_id: "role-to" },
      organization: {
        id: ORG_1,
        slug: "splatoon-fr",
        language: "fr",
        discordEnabled: true,
      },
    });
  });

  it("PERF-02: réutilise le cache req.adminCheck lorsque req.adminCheck.guildId correspond au discordGuildId de l'organisation", async () => {
    const out = await callRoute(organizationRouter, {
      method: "GET",
      path: `/${ORG_1}`,
      adminCheck: {
        discordId: "u-not-in-members",
        guildId: GUILD_1,
        access: { level: "SERVER", reason: "SERVER_OWNER" },
      },
      headers: { "x-discord-user-id": "u-not-in-members" },
    });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      id: ORG_1,
      slug: "splatoon-fr",
    });
  });
});

describe("SEC-18: rattachement d'un serveur Discord réservé à ses administrateurs", () => {
  const link = (user: string, client: unknown, body: Record<string, unknown>, org = ORG_2) =>
    callRoute(organizationRouter, {
      method: "PUT",
      path: `/${org}/integrations/DISCORD`,
      headers: { "x-discord-user-id": user },
      body,
      locals: { discordClient: client },
    });

  it("refuse un utilisateur sans droit de gestion sur le serveur", async () => {
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: false }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "GUILD_RIGHTS_REQUIRED" });
    expect(db.current?.writesTo("organization_integrations")).toEqual([]);
  });

  it("refuse si le bot n'est pas sur le serveur : les droits sont invérifiables", async () => {
    const out = await link("u-owner-2", discordClient(null), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: "BOT_NOT_IN_GUILD" });
    expect(db.current?.writesTo("organization_integrations")).toEqual([]);
  });

  it("accepte un administrateur vérifié et rattache le serveur Discord à l'organisation", async () => {
    db.current!.tables.tournaments!.push({ id: "t-2", organization_id: ORG_2, discord_config: {} });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_2)).toMatchObject({ external_id: GUILD_NEW, enabled: true });
  });

  it("LIFE-02: refuse d'activer Discord sans serveur lié", async () => {
    const out = await link("u-owner-2", discordClient(null), { enabled: true });
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: "GUILD_REQUIRED" });
  });

  it("réactiver un serveur déjà lié revérifie les droits", async () => {
    db.current!.tables.organization_integrations!.push({
      id: "int-2", organization_id: ORG_2, provider: "DISCORD", external_id: GUILD_NEW, enabled: false, status: "DISCONNECTED", config: {},
    });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: false }), { enabled: true });
    expect(out.status).toBe(403);
  });

  it("reprend l'organisation créée automatiquement à l'installation du bot si elle est vide", async () => {
    const shellId = "00000000-0000-0000-0000-000000000033";
    db.current!.tables.organizations!.push({ id: shellId, slug: `discord-${GUILD_NEW}`, name: "New Guild", language: "fr" });
    db.current!.tables.organization_integrations!.push({
      id: "int-shell", organization_id: shellId, provider: "DISCORD", external_id: GUILD_NEW, enabled: true, status: "CONNECTED", config: {},
    });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(200);
    expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(false);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_2)?.external_id).toBe(GUILD_NEW);
  });

  it("ne reprend jamais une organisation qui a déjà des tournois", async () => {
    const shellId = "00000000-0000-0000-0000-000000000033";
    db.current!.tables.organizations!.push({ id: shellId, slug: `discord-${GUILD_NEW}`, name: "New Guild", language: "fr" });
    db.current!.tables.organization_integrations!.push({
      id: "int-shell", organization_id: shellId, provider: "DISCORD", external_id: GUILD_NEW, enabled: true, status: "CONNECTED", config: {},
    });
    db.current!.tables.tournaments!.push({ id: "t-x", organization_id: shellId, discord_config: {} });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(409);
    expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(true);
  });

  it("SEC-42: refuse de détruire une org shell discord-<id> ayant déjà un autre propriétaire natif ou une config Discord personnalisée", async () => {
    const shellId = "00000000-0000-0000-0000-000000000034";
    db.current!.tables.organizations!.push({ id: shellId, slug: `discord-${GUILD_NEW}`, name: "New Guild", language: "fr" });
    db.current!.tables.organization_members!.push({ organization_id: shellId, user_id: "discord-server-owner", role: "ORG_OWNER" });
    db.current!.tables.organization_integrations!.push({
      id: "int-shell", organization_id: shellId, provider: "DISCORD", external_id: GUILD_NEW, enabled: true, status: "CONNECTED", config: {},
    });

    const stolenAttempt = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(stolenAttempt.status).toBe(409);
    expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(true);

    // Même si le propriétaire lui-même reprend, une config personnalisée déjà saisie empêche la suppression silencieuse
    db.current!.tables.organization_members!.find((m) => m.organization_id === shellId)!.user_id = "u-owner-2";
    db.current!.tables.organization_integrations!.find((i) => i.id === "int-shell")!.config = { to_role_id: "999999999999999999" };
    const configuredAttempt = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(configuredAttempt.status).toBe(409);
    expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(true);
  });

  it("SEC-42: un échec de chiffrement ne détruit jamais l'organisation shell discord-<id> avant écriture", async () => {
    const shellId = "00000000-0000-0000-0000-000000000035";
    db.current!.tables.organizations!.push({ id: shellId, slug: `discord-${GUILD_NEW}`, name: "New Guild", language: "fr" });
    db.current!.tables.organization_integrations!.push({
      id: "int-shell", organization_id: shellId, provider: "DISCORD", external_id: GUILD_NEW, enabled: true, status: "CONNECTED", config: {},
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", "");
    try {
      const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), {
        enabled: true,
        external_id: GUILD_NEW,
        secret_payload: "secret-that-fails-to-encrypt",
      });
      expect(out.status).toBe(500);
      expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("DAT-04 / SEC-45: changer de serveur Discord lié réinitialise discord_config des tournois et purge config de l'intégration", async () => {
    const existingInt = db.current!.tables.organization_integrations!.find((i) => i.organization_id === ORG_1);
    if (existingInt) {
      existingInt.config = {
        to_role_id: "666666666666666666",
        captain_role_id: "555555555555555555",
        registration_channel_id: "222222222222222222",
        announcement_channel_id: "333333333333333333",
        checkin_channel_id: "444444444444444444",
        guild_name: "Ancien Serveur",
      };
    }
    db.current!.tables.tournaments!.push({
      id: "t-switch",
      organization_id: ORG_1,
      discord_config: {
        category_id: "111",
        registration_channel_id: "222",
        announcement_channel_id: "333",
        checkin_channel_id: "444",
        captain_role_id: "555",
        to_role_id: "666",
      },
    });

    const out = await link("u-owner", discordClient({ id: "u-owner", manage: true }), { enabled: true, external_id: GUILD_NEW }, ORG_1);
    expect(out.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-switch")).toMatchObject({
      discord_config: {},
    });
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_1)?.config).toEqual({});
  });

  it("#101: couper puis réactiver Discord sur le même serveur préserve discord_config (salons et rôles des tournois)", async () => {
    const originalConfig = {
      category_id: "111",
      registration_channel_id: "222",
      announcement_channel_id: "333",
      checkin_channel_id: "444",
      captain_role_id: "555",
      to_role_id: "666",
    };
    db.current!.tables.tournaments!.push({
      id: "t-toggle",
      organization_id: ORG_1,
      discord_config: { ...originalConfig },
    });

    const disabled = await link("u-owner", discordClient({ id: "u-owner", manage: true }, GUILD_1), { enabled: false }, ORG_1);
    expect(disabled.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-toggle")?.discord_config).toEqual(originalConfig);

    const reenabled = await link("u-owner", discordClient({ id: "u-owner", manage: true }, GUILD_1), { enabled: true }, ORG_1);
    expect(reenabled.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-toggle")?.discord_config).toEqual(originalConfig);
  });

  it("CLN-08 / ARC-04: met à jour key_version selon INTEGRATION_ENCRYPTION_KEY_VERSION et conserve has_secret:true sans renvoyer de secret", async () => {
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_V2", "b".repeat(64));
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_VERSION", "2");
    try {
      const first = await callRoute(organizationRouter, {
        method: "PUT",
        path: `/${ORG_1}/integrations/AI`,
        headers: { "x-discord-user-id": "u-owner" },
        body: { provider: "AI", enabled: true, secret_payload: "sk-v2-secret" },
      });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ has_secret: true });
      const secretRow = db.current?.tables.organization_integration_secrets?.[0];
      expect(secretRow?.key_version).toBe(2);
      expect(String(secretRow?.encrypted_payload)).toMatch(/^v1:2:/);

      const second = await callRoute(organizationRouter, {
        method: "PUT",
        path: `/${ORG_1}/integrations/AI`,
        headers: { "x-discord-user-id": "u-owner" },
        body: { provider: "AI", enabled: true, config: { model: "gemini-2.5-pro" } },
      });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ has_secret: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("SEC-08 / SEC-07 / ACC-01: intégrations", () => {
  const put = (provider: string, body: Record<string, unknown>, user = "u-owner") =>
    callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/${provider}`,
      headers: { "x-discord-user-id": user },
      body,
    });

  it("SEC-08: refuse une clé de configuration inconnue, donc tout secret en clair", async () => {
    const out = await put("DISCORD", { config: { api_key: "plaintext-secret" } });
    expect(out.status).toBe(400);
  });

  it("SEC-08: refuse un identifiant de salon qui n'est pas un snowflake", async () => {
    const out = await put("DISCORD", { config: { registration_channel_id: "pas-un-id" } });
    expect(out.status).toBe(400);
  });

  it("SEC-07: un chiffrement impossible n'écrit rien (ni intégration ni secret)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", "");
    try {
      const out = await put("TWITCH", { enabled: true, secret_payload: "tok" });
      expect(out.status).toBe(500);
      expect(db.current?.tables.organization_integrations?.some((i) => i.provider === "TWITCH")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ACC-01: refuse de couper Discord s'il ne reste aucun responsable natif", async () => {
    db.current!.tables.organization_members = [];
    const fakeDiscord = {
      guilds: {
        fetch: () =>
          Promise.resolve({
            ownerId: "u-discord-owner",
            members: { fetch: () => Promise.resolve({ permissions: { has: () => false }, roles: { cache: { has: () => false } } }) },
          }),
      },
    };
    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/DISCORD`,
      headers: { "x-discord-user-id": "u-discord-owner" },
      body: { enabled: false },
      locals: { discordClient: fakeDiscord },
    });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: "NO_NATIVE_MANAGER" });
    expect(db.current?.tables.organization_integrations?.[0]?.enabled).toBe(true);
  });
});

describe("SEC-04: lecture de l'organisation", () => {
  it("un staff de tournoi ne lit ni les membres ni les intégrations", async () => {
    db.current!.tables.tournaments!.push({ id: "t-1", organization_id: ORG_1, status: "ACTIVE", discord_config: {} });
    db.current!.tables.tournament_staff!.push({ tournament_id: "t-1", user_id: "u-caster", role: "CASTER" });
    const out = await callRoute(organizationRouter, {
      method: "GET",
      path: `/${ORG_1}`,
      headers: { "x-discord-user-id": "u-caster" },
      locals: {
        discordClient: {
          guilds: { fetch: () => Promise.resolve({ ownerId: "x", members: { fetch: () => Promise.reject(new Error("no")) } }) },
        },
      },
    });
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).not.toContain("u-owner");
  });

  it("SEC-19: expose has_secret, jamais le secret", async () => {
    db.current!.tables.organization_integration_secrets!.push({ integration_id: "int-1", encrypted_payload: "v1:cipher", key_version: 1 });
    const out = await callRoute(organizationRouter, {
      method: "GET",
      path: `/${ORG_1}`,
      headers: { "x-discord-user-id": "u-owner" },
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ integrations: [{ id: "int-1", has_secret: true }] });
    expect(JSON.stringify(out.body)).not.toContain("v1:cipher");
  });
});

describe("SEC-06: création, quota et conflits rapportés par la base", () => {
  const create = () =>
    callRoute(organizationRouter, {
      method: "POST",
      path: "/",
      headers: { "x-discord-user-id": "u-new" },
      body: { name: "Org", slug: "nouvelle-org" },
    });

  it("le quota SQL répond 403 QUOTA_EXCEEDED", async () => {
    orgRpc.error = { code: "HT001", message: "quota" };
    const out = await create();
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("CLN-02: un slug pris en course répond 409, jamais 500", async () => {
    orgRpc.error = { code: "23505", message: "duplicate" };
    const out = await create();
    expect(out.status).toBe(409);
  });

  it("CLN-01: refuse un slug réservé par une route du site", async () => {
    const out = await callRoute(organizationRouter, {
      method: "POST",
      path: "/",
      headers: { "x-discord-user-id": "u-new" },
      body: { name: "Org", slug: "admin" },
    });
    expect(out.status).toBe(400);
  });

  it("CLN-02: renommer vers un slug pris répond 409", async () => {
    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}`,
      headers: { "x-discord-user-id": "u-owner" },
      body: { slug: "other-org" },
    });
    expect(out.status).toBe(409);
  });
});

describe("RFC Q2.4: transfert de propriété, suppression et invitations", () => {
  const as = (user: string) => ({ "x-discord-user-id": user });

  it("transfère à un ORG_ADMIN natif et rétrograde l'ancien propriétaire", async () => {
    const out = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/transfer`, headers: as("u-owner"), body: { new_owner_id: "u-admin", demote_self: true },
    });
    expect(out.status).toBe(200);
    const roles = Object.fromEntries(db.current!.tables.organization_members!.map((m) => [m.user_id, m.role]));
    expect(roles).toMatchObject({ "u-admin": "ORG_OWNER", "u-owner": "ORG_ADMIN" });
  });

  it("refuse le transfert à un non-ORG_ADMIN et à un appelant non propriétaire", async () => {
    const wrongTarget = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/transfer`, headers: as("u-owner"), body: { new_owner_id: "u-to" },
    });
    expect(wrongTarget.status).toBe(400);
    const wrongCaller = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/transfer`, headers: as("u-admin"), body: { new_owner_id: "u-admin" },
    });
    expect(wrongCaller.status).toBe(403);
  });

  it("seul le propriétaire supprime l'organisation, en retapant son slug", async () => {
    const admin = await callRoute(organizationRouter, {
      method: "DELETE", path: `/${ORG_1}`, headers: as("u-admin"), body: { confirm_slug: "splatoon-fr" },
    });
    expect(admin.status).toBe(403);
    const wrongSlug = await callRoute(organizationRouter, {
      method: "DELETE", path: `/${ORG_1}`, headers: as("u-owner"), body: { confirm_slug: "oops" },
    });
    expect(wrongSlug.status).toBe(400);
    const ok = await callRoute(organizationRouter, {
      method: "DELETE", path: `/${ORG_1}`, headers: as("u-owner"), body: { confirm_slug: "splatoon-fr" },
    });
    expect(ok.status).toBe(200);
    expect(db.current?.tables.organizations?.some((o) => o.id === ORG_1)).toBe(false);
  });

  it("crée une invitation : jeton renvoyé une seule fois, seul son hash est stocké", async () => {
    const out = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/invites`, headers: as("u-admin"), body: { role: "ORG_TO" },
    });
    expect(out.status).toBe(201);
    const { token } = out.body as { token: string };
    expect(token.length).toBeGreaterThanOrEqual(43);
    const stored = db.current!.tables.organization_invites![0]!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(token);
  });

  it("refuse d'inviter un ORG_OWNER et à un simple TO d'inviter", async () => {
    const owner = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/invites`, headers: as("u-owner"), body: { role: "ORG_OWNER" },
    });
    expect(owner.status).toBe(400);
    const to = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/invites`, headers: as("u-to"), body: { role: "MEMBER" },
    });
    expect(to.status).toBe(403);
  });

  it("une invitation de tournoi refuse un tournoi d'une autre organisation", async () => {
    db.current!.tables.tournaments!.push({ id: "a0000000-0000-4000-8000-0000000000f2", organization_id: ORG_2 });
    const out = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/invites`, headers: as("u-owner"),
      body: { role: "CASTER", tournament_id: "a0000000-0000-4000-8000-0000000000f2" },
    });
    expect(out.status).toBe(403);
    expect(db.current?.tables.organization_invites).toEqual([]);
  });

  it("accepte une invitation une seule fois", async () => {
    const created = await callRoute(organizationRouter, {
      method: "POST", path: `/${ORG_1}/invites`, headers: as("u-admin"), body: { role: "ORG_TO" },
    });
    const { token } = created.body as { token: string };
    const first = await callRoute(organizationRouter, { method: "POST", path: "/invites/accept", headers: as("u-new"), body: { token } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ slug: "splatoon-fr" });
    const second = await callRoute(organizationRouter, { method: "POST", path: "/invites/accept", headers: as("u-other"), body: { token } });
    expect(second.status).toBe(410);
  });

  it("retire un staff de tournoi et refuse un tournoi d'une autre organisation", async () => {
    db.current!.tables.tournaments!.push({ id: "t-1", organization_id: ORG_1, status: "ACTIVE" }, { id: "t-2", organization_id: ORG_2, status: "ACTIVE" });
    db.current!.tables.tournament_staff!.push({ tournament_id: "t-1", user_id: "u-caster", role: "CASTER" });
    const other = await callRoute(organizationRouter, {
      method: "DELETE", path: `/${ORG_1}/tournaments/t-2/staff/u-caster`, headers: as("u-owner"),
    });
    expect(other.status).toBe(403);
    const ok = await callRoute(organizationRouter, {
      method: "DELETE", path: `/${ORG_1}/tournaments/t-1/staff/u-caster`, headers: as("u-owner"),
    });
    expect(ok.status).toBe(200);
    expect(db.current?.tables.tournament_staff).toEqual([]);
  });
});

describe("DISC-16 (#105): réenregistrement du serveur Discord lorsqu'il perd son intégration", () => {
  const as = (user: string) => ({ "x-discord-user-id": user });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  /** Faux client Discord qui connaît plusieurs serveurs et renvoie des objets GuildLike complets. */
  function multiGuildDiscordClient(presentGuilds: Record<string, { name: string; ownerId: string; manageUsers?: string[] }>) {
    const fetch = vi.fn((guildId: string) => {
      const entry = presentGuilds[guildId];
      if (!entry) return Promise.reject(Object.assign(new Error("Unknown Guild"), { code: 10004 }));
      const ownerMember = {
        id: entry.ownerId,
        user: { bot: false },
        permissions: { has: () => true },
        roles: { cache: { has: () => false } },
      };
      return Promise.resolve({
        id: guildId,
        name: entry.name,
        icon: null,
        ownerId: entry.ownerId,
        preferredLocale: "fr",
        members: {
          fetch: (userId?: string) => {
            if (typeof userId === "string") {
              const canManage = entry.ownerId === userId || (entry.manageUsers ?? []).includes(userId);
              return Promise.resolve({
                id: userId,
                user: { bot: false },
                permissions: { has: () => canManage },
                roles: { cache: { has: () => false } },
              });
            }
            return Promise.resolve(new Map([[entry.ownerId, ownerMember]]));
          },
        },
      });
    });
    return { guilds: { fetch } };
  }

  it("DISC-16: supprimer une organisation liée à un serveur où le bot est encore présent recrée l'organisation discord-<id>, son intégration et resynchronise ses grants", async () => {
    const client = multiGuildDiscordClient({ [GUILD_1]: { name: "Serveur Splatoon", ownerId: "u-owner" } });
    const out = await callRoute(organizationRouter, {
      method: "DELETE",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { confirm_slug: "splatoon-fr" },
      locals: { discordClient: client },
    });

    expect(out.status).toBe(200);
    expect(db.current?.tables.organizations?.some((o) => o.id === ORG_1)).toBe(false);
    const recreatedOrg = db.current?.tables.organizations?.find((o) => o.slug === `discord-${GUILD_1}`);
    expect(recreatedOrg).toBeDefined();
    const recreatedInt = db.current?.tables.organization_integrations?.find(
      (i) => i.provider === "DISCORD" && i.external_id === GUILD_1,
    );
    expect(recreatedInt).toMatchObject({
      organization_id: recreatedOrg?.id,
      enabled: true,
      status: "CONNECTED",
      config: expect.objectContaining({ bot_present: true, guild_name: "Serveur Splatoon" }),
    });

    // Vérifie que refreshGuildAccess a bien resynchronisé l'annuaire en arrière-plan pour la nouvelle org
    await flush();
    await flush();
    expect(db.current?.tables.integration_access_grants).toContainEqual(
      expect.objectContaining({
        organization_id: recreatedOrg?.id,
        provider: "DISCORD",
        user_id: "u-owner",
        reason: "SERVER_OWNER",
      }),
    );
  });

  it("DISC-16: supprimer une organisation reste 200 si le bot n'est plus sur le serveur (Unknown Guild)", async () => {
    const client = multiGuildDiscordClient({});
    const out = await callRoute(organizationRouter, {
      method: "DELETE",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { confirm_slug: "splatoon-fr" },
      locals: { discordClient: client },
    });

    expect(out.status).toBe(200);
    expect(db.current?.tables.organizations?.some((o) => o.id === ORG_1)).toBe(false);
    expect(db.current?.tables.organization_integrations?.some((i) => i.external_id === GUILD_1)).toBe(false);
  });

  it("DISC-16: un refus 403 ou 400 sur DELETE ne déclenche aucun réenregistrement", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("should not be called")));
    const wrongSlug = await callRoute(organizationRouter, {
      method: "DELETE",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { confirm_slug: "wrong" },
      locals: { discordClient: { guilds: { fetch: fetchSpy } } },
    });
    expect(wrongSlug.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Un ORG_ADMIN natif (sans droit DELETE_ORGANIZATION) reçoit 403 sans réenregistrement
    const forbidden = await callRoute(organizationRouter, {
      method: "DELETE",
      path: `/${ORG_1}`,
      headers: as("u-admin"),
      body: { confirm_slug: "splatoon-fr" },
      locals: { discordClient: { guilds: { fetch: fetchSpy } } },
    });
    expect(forbidden.status).toBe(403);
    expect(db.current?.tables.organizations?.some((o) => o.id === ORG_1)).toBe(true);
    expect(db.current?.tables.organizations?.some((o) => o.slug === `discord-${GUILD_1}`)).toBe(false);
  });

  it("DISC-16: changer de serveur Discord lié (G1 -> G2) réenregistre l'ancien serveur G1 si le bot y est encore", async () => {
    const client = multiGuildDiscordClient({
      [GUILD_1]: { name: "Ancien Serveur", ownerId: "u-owner", manageUsers: ["u-owner"] },
      [GUILD_NEW]: { name: "Nouveau Serveur", ownerId: "u-owner", manageUsers: ["u-owner"] },
    });

    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/DISCORD`,
      headers: as("u-owner"),
      body: { enabled: true, external_id: GUILD_NEW },
      locals: { discordClient: client },
    });

    expect(out.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_1)?.external_id).toBe(GUILD_NEW);

    const restoredOrg = db.current?.tables.organizations?.find((o) => o.slug === `discord-${GUILD_1}`);
    expect(restoredOrg).toBeDefined();
    expect(
      db.current?.tables.organization_integrations?.find((i) => i.external_id === GUILD_1),
    ).toMatchObject({
      organization_id: restoredOrg?.id,
      enabled: true,
      status: "CONNECTED",
    });
  });

  it("DISC-16: délier le serveur Discord (external_id: null) depuis une organisation Web réenregistre ce serveur", async () => {
    const client = multiGuildDiscordClient({
      [GUILD_1]: { name: "Serveur Délié", ownerId: "u-owner", manageUsers: ["u-owner"] },
    });

    const out = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}/integrations/DISCORD`,
      headers: as("u-owner"),
      body: { external_id: null },
      locals: { discordClient: client },
    });

    expect(out.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_1)).toMatchObject({
      external_id: null,
      enabled: false,
    });

    const restoredOrg = db.current?.tables.organizations?.find((o) => o.slug === `discord-${GUILD_1}`);
    expect(restoredOrg).toBeDefined();
    expect(
      db.current?.tables.organization_integrations?.find((i) => i.external_id === GUILD_1),
    ).toMatchObject({
      organization_id: restoredOrg?.id,
      enabled: true,
      status: "CONNECTED",
    });
  });

  it("DISC-16: délier ou changer de serveur depuis l'organisation shell discord-<id> elle-même ne tente pas de recréer son propre slug", async () => {
    const shellId = "00000000-0000-0000-0000-000000000099";
    const shellGuild = "333333333333333333";
    db.current!.tables.organizations!.push({ id: shellId, slug: `discord-${shellGuild}`, name: "Shell Guild", language: "fr" });
    db.current!.tables.organization_members!.push({ organization_id: shellId, user_id: "u-shell-owner", role: "ORG_OWNER" });
    db.current!.tables.organization_integrations!.push({
      id: "int-shell-99",
      organization_id: shellId,
      provider: "DISCORD",
      external_id: shellGuild,
      enabled: true,
      status: "CONNECTED",
      config: {},
    });

    const client = multiGuildDiscordClient({
      [shellGuild]: { name: "Shell Guild", ownerId: "u-shell-owner", manageUsers: ["u-shell-owner"] },
      [GUILD_NEW]: { name: "Nouveau Serveur", ownerId: "u-shell-owner", manageUsers: ["u-shell-owner"] },
    });

    // 1) Bascule vers un autre serveur G2 : aucun fetch de réenregistrement sur shellGuild
    const switched = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${shellId}/integrations/DISCORD`,
      headers: as("u-shell-owner"),
      body: { enabled: true, external_id: GUILD_NEW },
      locals: { discordClient: client },
    });
    expect(switched.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.some((i) => i.external_id === shellGuild)).toBe(false);

    // 2) Rétablissement puis déliaison (external_id: null) : ne réattache pas de force
    db.current!.tables.organization_integrations!.find((i) => i.organization_id === shellId)!.external_id = shellGuild;
    const unlinked = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${shellId}/integrations/DISCORD`,
      headers: as("u-shell-owner"),
      body: { external_id: null },
      locals: { discordClient: client },
    });

    expect(unlinked.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === shellId)).toMatchObject({
      external_id: null,
      enabled: false,
    });
    expect(db.current?.tables.organization_integrations?.some((i) => i.external_id === shellGuild)).toBe(false);
  });
});

describe("SEC-08 (#102): lien de contact public https sur une organisation", () => {
  const as = (userId: string) => ({ "x-discord-user-id": userId });

  it("accepte un lien de contact https générique et une invitation Discord (création et mise à jour)", async () => {
    const created = await callRoute(organizationRouter, {
      method: "POST",
      path: "/",
      headers: as("u-owner"),
      body: {
        name: "Web Only Org",
        slug: "web-only-org",
        invite_url: "https://example.org/contact?ref=hub",
      },
    });
    expect(created.status).toBe(201);

    const updatedGeneric = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { invite_url: "https://community.example.org/tournaments" },
    });
    expect(updatedGeneric.status).toBe(200);
    expect(db.current?.tables.organizations?.find((o) => o.id === ORG_1)?.invite_url).toBe(
      "https://community.example.org/tournaments",
    );

    const updatedDiscord = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { invite_url: "https://discord.gg/splatoon-fr" },
    });
    expect(updatedDiscord.status).toBe(200);
    expect(db.current?.tables.organizations?.find((o) => o.id === ORG_1)?.invite_url).toBe(
      "https://discord.gg/splatoon-fr",
    );
  });

  it.each([
    ["HTTP non chiffré", "http://example.org/contact"],
    ["schéma javascript", "javascript:alert(1)"],
    ["schéma data", "data:text/html,<script>alert(1)</script>"],
    ["credentials dans l'URL", "https://user:pass@example.org/contact"],
    ["hôte sans TLD", "https://localhost/contact"],
    ["espaces dans l'URL", "https://example.org/mon lien"],
    ["URL trop longue", `https://example.org/${"a".repeat(520)}`],
  ])("rejette un lien invalide (%s) en 400 sans écriture", async (_label, invalidUrl) => {
    const res = await callRoute(organizationRouter, {
      method: "PUT",
      path: `/${ORG_1}`,
      headers: as("u-owner"),
      body: { invite_url: invalidUrl },
    });
    expect(res.status).toBe(400);
    expect(db.current?.writesTo("organizations", "update")).toEqual([]);
  });
});

