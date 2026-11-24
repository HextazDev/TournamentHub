import { describe, it, expect, beforeEach, vi } from "vitest";

const from = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  resolveOrganization,
  verifyTournamentOrganization,
  clearOrganizationCache,
  runWithRequestTenantCache,
} from "../utils/tenant";

function orgRow(id: string) {
  return {
    id,
    slug: `slug-${id}`,
    name: `Org ${id}`,
    language: "fr",
    invite_url: null,
    organization_integrations: [
      { provider: "DISCORD", external_id: `guild-${id}`, enabled: true, config: {} },
    ],
  };
}

function chainable(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "maybeSingle"]) {
    builder[method] = vi.fn(() => (method === "maybeSingle" ? Promise.resolve(result) : builder));
  }
  return builder;
}

describe("PERF-01: cache de résolution d'organisation borné à la requête", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ne fait qu'une seule résolution pour des appels répétés au sein d'une même requête", async () => {
    const row = orgRow("11111111-1111-1111-1111-111111111111");
    from.mockReturnValue(chainable({ data: row, error: null }));

    await runWithRequestTenantCache(async () => {
      const first = await resolveOrganization(row.id);
      const readsAfterFirst = from.mock.calls.length;
      const second = await resolveOrganization(row.id);

      expect(first?.id).toBe(row.id);
      expect(second?.id).toBe(row.id);
      expect(readsAfterFirst).toBeGreaterThan(0);
      expect(from).toHaveBeenCalledTimes(readsAfterFirst);
    });
  });

  it("réutilise la résolution entre les verifyTournamentOrganization d'une même requête", async () => {
    const row = orgRow("22222222-2222-2222-2222-222222222222");
    const tournament = { data: { organization_id: row.id }, error: null };
    const org = chainable({ data: row, error: null });
    from.mockImplementation((table: string) => (table === "tournaments" ? chainable(tournament) : org));

    await runWithRequestTenantCache(async () => {
      await verifyTournamentOrganization("t-1", `guild-${row.id}`);
      const selectionsAfterFirst = (org.select as ReturnType<typeof vi.fn>).mock.calls.length;
      await verifyTournamentOrganization("t-2", `guild-${row.id}`);

      expect(from).toHaveBeenCalledWith("organizations");
      expect(selectionsAfterFirst).toBeGreaterThan(0);
      expect((org.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(selectionsAfterFirst);
    });
  });

  it("ne partage aucune résolution entre deux requêtes successives", async () => {
    const row = orgRow("33333333-3333-3333-3333-333333333333");
    from.mockReturnValue(chainable({ data: row, error: null }));

    await runWithRequestTenantCache(async () => {
      await resolveOrganization(row.id);
    });
    const readsAfterFirstRequest = from.mock.calls.length;

    await runWithRequestTenantCache(async () => {
      await resolveOrganization(row.id);
    });

    expect(readsAfterFirstRequest).toBeGreaterThan(0);
    expect(from).toHaveBeenCalledTimes(readsAfterFirstRequest * 2);
  });

  it("ne met jamais en cache une résolution en échec (null) et relit la base", async () => {
    from.mockReturnValue(chainable({ data: null, error: null }));

    await runWithRequestTenantCache(async () => {
      expect(await resolveOrganization("unknown-slug")).toBeNull();
      const readsAfterFirst = from.mock.calls.length;
      expect(await resolveOrganization("unknown-slug")).toBeNull();

      expect(readsAfterFirst).toBeGreaterThan(0);
      expect(from).toHaveBeenCalledTimes(readsAfterFirst * 2);
    });
  });

  it("relit la base après invalidation explicite au sein de la requête", async () => {
    const row = orgRow("44444444-4444-4444-4444-444444444444");
    from.mockReturnValue(chainable({ data: row, error: null }));

    await runWithRequestTenantCache(async () => {
      await resolveOrganization(row.id);
      const readsAfterFirst = from.mock.calls.length;
      clearOrganizationCache();
      await resolveOrganization(row.id);

      expect(readsAfterFirst).toBeGreaterThan(0);
      expect(from).toHaveBeenCalledTimes(readsAfterFirst * 2);
    });
  });

  it("hors requête HTTP (planificateur, scripts), la base est toujours relue", async () => {
    const row = orgRow("55555555-5555-5555-5555-555555555555");
    from.mockReturnValue(chainable({ data: row, error: null }));

    await resolveOrganization(row.id);
    const readsAfterFirst = from.mock.calls.length;
    await resolveOrganization(row.id);

    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(from).toHaveBeenCalledTimes(readsAfterFirst * 2);
  });

  it("CLN-07: une erreur DB sur organization_integrations lève au lieu de mettre en cache discordEnabled=false", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const row = { id, slug: "my-org", name: "My Org", language: "fr", invite_url: null };
    from.mockImplementation((table: string) =>
      table === "organization_integrations"
        ? chainable({ data: null, error: { code: "08006", message: "connection failure" } })
        : chainable({ data: row, error: null }),
    );

    await runWithRequestTenantCache(async () => {
      await expect(resolveOrganization(id)).rejects.toMatchObject({ message: "connection failure" });
      // Si l'erreur disparaît sur l'appel suivant, la base est relue (rien n'a été mis en cache)
      from.mockImplementation((table: string) =>
        table === "organization_integrations"
          ? chainable({ data: { organization_id: id, provider: "DISCORD", external_id: "123456789012345678", enabled: true, config: {} }, error: null })
          : chainable({ data: row, error: null }),
      );
      const recovered = await resolveOrganization(id);
      expect(recovered?.discordEnabled).toBe(true);
    });
  });

  it("PERF-01: indexe le cache par tous les alias (id, slug, discordGuildId) au sein de la requête", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const row = { id, slug: "alias-org", name: "Alias Org", language: "fr", invite_url: null };
    const integration = { organization_id: id, provider: "DISCORD", external_id: "987654321098765432", enabled: true, config: {} };
    from.mockImplementation((table: string) =>
      table === "organization_integrations"
        ? chainable({ data: integration, error: null })
        : chainable({ data: row, error: null }),
    );

    await runWithRequestTenantCache(async () => {
      const byId = await resolveOrganization(id);
      const callsAfterFirst = from.mock.calls.length;
      const bySlug = await resolveOrganization("alias-org");
      const byGuild = await resolveOrganization("987654321098765432");

      expect(byId?.id).toBe(id);
      expect(bySlug?.id).toBe(id);
      expect(byGuild?.id).toBe(id);
      expect(from).toHaveBeenCalledTimes(callsAfterFirst);
    });
  });

  it("DISC-17 / SEC-26: un timer de rejeu planifié depuis une requête HTTP ne lit jamais le cache HTTP périmé", async () => {
    vi.useFakeTimers();
    const { refreshGuildAccess, resetAccessRefreshState } = await import("../services/AccessRefreshService");
    resetAccessRefreshState();
    try {
      const orgId = "88888888-8888-8888-8888-888888888888";
      const guildId = "111222333444555666";
      let discordEnabled = true;
      const grantOps: string[] = [];

      from.mockImplementation((table: string) => {
        if (table === "organizations") {
          return chainable({ data: { id: orgId, slug: "live-org", name: "Live Org", language: "fr", invite_url: null }, error: null });
        }
        if (table === "organization_integrations") {
          return chainable({
            data: { organization_id: orgId, provider: "DISCORD", external_id: guildId, enabled: discordEnabled, config: {} },
            error: null,
          });
        }
        if (table === "tournaments") {
          const b: Record<string, unknown> = {};
          for (const m of ["select", "eq", "neq"]) b[m] = vi.fn(() => b);
          b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
          return b;
        }
        if (table === "integration_access_grants") {
          const b: Record<string, unknown> = {};
          b.upsert = vi.fn(() => (grantOps.push("upsert"), Promise.resolve({ error: null })));
          b.delete = vi.fn(() => (grantOps.push("delete"), b));
          b.eq = vi.fn(() => b);
          b.lt = vi.fn(() => b);
          b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
          return b;
        }
        return chainable({ data: null, error: null });
      });

      const rateLimitErr = Object.assign(
        new Error("Request with opcode 8 was rate limited. Retry after 2 seconds."),
        { name: "GatewayRateLimitError", data: { opcode: 8, retry_after: 2 } },
      );
      const membersFetch = vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce(
          new Map([
            [
              "owner-1",
              {
                id: "owner-1",
                user: { bot: false },
                permissions: { has: () => true },
                roles: { cache: { has: () => false } },
              },
            ],
          ]),
        );

      const discordClient = {
        guilds: {
          fetch: vi.fn(async () => ({
            id: guildId,
            name: "Live Guild",
            icon: null,
            ownerId: "owner-1",
            preferredLocale: "fr",
            members: { fetch: membersFetch },
          })),
        },
      };

      // Requête HTTP #1 : active Discord et peuple le cache AsyncLocalStorage avec discordEnabled = true
      await runWithRequestTenantCache(async () => {
        const cached = await resolveOrganization(orgId);
        expect(cached?.discordEnabled).toBe(true);
        refreshGuildAccess(discordClient, orgId);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(membersFetch).toHaveBeenCalledTimes(1);

      // Avant l'échéance du timer de rejeu (2 s), une autre requête coupe Discord en base (SEC-26)
      discordEnabled = false;

      // Le timer de rejeu se déclenche : il doit relire discordEnabled=false et purger au lieu de réinsérer
      await vi.advanceTimersByTimeAsync(2_500);
      expect(grantOps).not.toContain("upsert");
      expect(grantOps).toContain("delete");
      expect(membersFetch).toHaveBeenCalledTimes(1);
    } finally {
      resetAccessRefreshState();
      vi.useRealTimers();
    }
  });
});
