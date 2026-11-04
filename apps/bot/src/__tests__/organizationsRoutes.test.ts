import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));

import { organizationRouter } from "../routes/OrganizationRouter";
import { clearMemberAccessCache, resolveMemberAccess } from "../services/MemberAccessService";
import { callRoute } from "./helpers/route";

const ORG_1 = "00000000-0000-0000-0000-000000000011";
const ORG_2 = "00000000-0000-0000-0000-000000000022";

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberAccessCache();
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
        external_id: "guild-1",
        enabled: true,
        status: "CONNECTED",
        config: { to_role_id: "role-to" },
      },
    ],
    organization_integration_secrets: [],
    integration_access_grants: [],
    tournaments: [],
    tournament_staff: [],
  });
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
      body: { provider: "DISCORD", external_id: "guild-1", enabled: true },
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
        guildId: "guild-1",
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
