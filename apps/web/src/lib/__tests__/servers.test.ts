import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  responses: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock("../supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(state.responses[table] ?? { data: [], error: null }).then(resolve),
      };
      return chain;
    },
  },
}));

import { loadServerOverview } from "../servers";

describe("loadServerOverview — CLN-07 propagation d'erreur & CLN-06 pas de droits fabriqués", () => {
  beforeEach(() => {
    state.responses = {};
  });

  it("CLN-07: remonte une erreur si la lecture de organization_members échoue (jamais une liste vide silencieuse)", async () => {
    state.responses.organization_members = { data: null, error: { message: "db connection lost" } };
    await expect(
      loadServerOverview({ discordId: "u-1", guilds: [], guildsError: false }),
    ).rejects.toThrow("organization_members read failed");
  });

  it("CLN-07: remonte une erreur si la lecture de organizations échoue", async () => {
    state.responses.organization_members = {
      data: [{ organization_id: "org-1", role: "ORG_OWNER" }],
      error: null,
    };
    state.responses.organizations = { data: null, error: { message: "organizations unavailable" } };

    await expect(
      loadServerOverview({ discordId: "u-1", guilds: [], guildsError: false }),
    ).rejects.toThrow("organizations read failed");
  });

  it("CLN-06: une organisation Web native ne fabrique pas owner:true ni permissions:'8'", async () => {
    state.responses.organization_members = {
      data: [{ organization_id: "org-1", role: "ORG_OWNER" }],
      error: null,
    };
    state.responses.organizations = {
      data: [{ id: "org-1", slug: "ink-cup", name: "Ink Cup", icon_url: null }],
      error: null,
    };

    const out = await loadServerOverview({ discordId: "u-1", guilds: [], guildsError: false });
    expect(out.managedServers).toHaveLength(1);
    expect(out.managedServers[0]?.guild).toEqual({
      id: "ink-cup",
      name: "Ink Cup",
      icon: null,
      owner: false,
      permissions: "0",
    });
  });
});
