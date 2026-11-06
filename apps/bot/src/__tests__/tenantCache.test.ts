import { describe, it, expect, beforeEach, vi } from "vitest";

const from = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  resolveOrganization,
  verifyTournamentGuild,
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

  it("réutilise la résolution entre les verifyTournamentGuild d'une même requête", async () => {
    const row = orgRow("22222222-2222-2222-2222-222222222222");
    const tournament = { data: { guild_id: `guild-${row.id}`, organization_id: row.id }, error: null };
    const org = chainable({ data: row, error: null });
    from.mockImplementation((table: string) => (table === "tournaments" ? chainable(tournament) : org));

    await runWithRequestTenantCache(async () => {
      await verifyTournamentGuild("t-1", `guild-${row.id}`);
      const selectionsAfterFirst = (org.select as ReturnType<typeof vi.fn>).mock.calls.length;
      await verifyTournamentGuild("t-2", `guild-${row.id}`);

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
});
