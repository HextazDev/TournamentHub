import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { callRoute } from "./helpers/route";

const ORG_1 = "00000000-0000-0000-0000-000000000011";
const ORG_2 = "00000000-0000-0000-0000-000000000022";
const GUILD_1 = "111111111111111111";
const GUILD_NEW = "222222222222222222";

/** Faux client Discord : `caller` possède les droits demandés sur GUILD_NEW, le bot n'est présent que là. */
function discordClient(caller: { id: string; manage: boolean } | null) {
  return {
    guilds: {
      fetch: (guildId: string) =>
        guildId !== GUILD_NEW || !caller
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

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberAccessCache();
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

  it("accepte un administrateur vérifié et rattache les tournois existants", async () => {
    db.current!.tables.tournaments!.push({ id: "t-2", organization_id: ORG_2, guild_id: null });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(200);
    expect(db.current?.tables.organization_integrations?.find((i) => i.organization_id === ORG_2)).toMatchObject({ external_id: GUILD_NEW, enabled: true });
    expect(db.current?.tables.tournaments?.find((t) => t.id === "t-2")?.guild_id).toBe(GUILD_NEW);
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
    db.current!.tables.tournaments!.push({ id: "t-x", organization_id: shellId, guild_id: GUILD_NEW });
    const out = await link("u-owner-2", discordClient({ id: "u-owner-2", manage: true }), { enabled: true, external_id: GUILD_NEW });
    expect(out.status).toBe(409);
    expect(db.current?.tables.organizations?.some((o) => o.id === shellId)).toBe(true);
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
    db.current!.tables.tournaments!.push({ id: "t-1", organization_id: ORG_1, status: "ACTIVE", discord_to_role_id: null });
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
