import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tournament } from "@hub/shared";

interface Row {
  [key: string]: unknown;
}

const state = vi.hoisted(() => ({
  tables: {
    tournaments: [] as Row[],
    organization_integrations: [] as Row[],
    organization_members: [] as Row[],
    tournament_staff: [] as Row[],
  },
}));

function matchesFilters(
  table: string,
  row: Row,
  filters: { op: "eq" | "neq" | "in"; col: string; val: unknown }[],
): boolean {
  for (const f of filters) {
    if (f.col.includes(".")) {
      const [rel, relCol] = f.col.split(".");
      if (table === "tournament_staff" && rel === "tournaments" && relCol) {
        const joined = state.tables.tournaments.find((t) => t.id === row.tournament_id);
        if (!joined) return false;
        const v = joined[relCol];
        if (f.op === "eq" && v !== f.val) return false;
        if (f.op === "neq" && v === f.val) return false;
        continue;
      }
    }
    const v = row[f.col];
    if (f.op === "eq" && v !== f.val) return false;
    if (f.op === "neq" && v === f.val) return false;
    if (f.op === "in" && !(Array.isArray(f.val) && f.val.includes(v))) return false;
  }
  return true;
}

vi.mock("../supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: keyof typeof state.tables) => {
      const filters: { op: "eq" | "neq" | "in"; col: string; val: unknown }[] = [];
      let isMaybeSingle = false;
      const run = () => {
        const rows = (state.tables[table] ?? []).filter((r) => matchesFilters(table, r, filters));
        if (isMaybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      };
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ op: "eq", col, val });
          return chain;
        },
        neq: (col: string, val: unknown) => {
          filters.push({ op: "neq", col, val });
          return chain;
        },
        in: (col: string, val: unknown[]) => {
          filters.push({ op: "in", col, val });
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          isMaybeSingle = true;
          return Promise.resolve(run());
        },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return chain;
    },
  },
}));

import { loadDiscoverableTournaments, loadOrganizationHubTournaments } from "../tournamentDiscovery";

const ORG_X = "00000000-0000-0000-0000-000000000011";
const ORG_Y = "00000000-0000-0000-0000-000000000022";

function makeTournament(overrides: Partial<Tournament> & { id: string; organization_id: string }): Row {
  return {
    name: overrides.id,
    is_public: false,
    status: "ACTIVE",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.tables = {
    tournaments: [
      makeTournament({ id: "t-pub", organization_id: ORG_X, is_public: true, created_at: "2026-11-03T10:00:00Z" }),
      makeTournament({ id: "t-priv-a", organization_id: ORG_X, is_public: false, created_at: "2026-11-02T10:00:00Z" }),
      makeTournament({ id: "t-priv-b", organization_id: ORG_X, is_public: false, created_at: "2026-11-01T10:00:00Z" }),
      makeTournament({ id: "t-archived", organization_id: ORG_X, is_public: false, status: "ARCHIVED" }),
      makeTournament({ id: "t-other-priv", organization_id: ORG_Y, is_public: false }),
    ],
    organization_integrations: [
      { organization_id: ORG_X, provider: "DISCORD", external_id: "guild-x", enabled: true },
      { organization_id: ORG_Y, provider: "DISCORD", external_id: "guild-y", enabled: false },
    ],
    organization_members: [],
    tournament_staff: [],
  };
});

describe("loadDiscoverableTournaments (AUD-SEC-01 / SEC-10 / SEC-21 / SEC-23)", () => {
  it("un tournament_staff sur le tournoi A ne voit PAS le tournoi privé B de la même organisation", async () => {
    state.tables.tournament_staff.push({ tournament_id: "t-priv-a", user_id: "u-staff", role: "CASTER" });

    const { publicList, privateList } = await loadDiscoverableTournaments("u-staff", []);
    expect(publicList.map((t) => t.id)).toEqual(["t-pub"]);
    expect(privateList.map((t) => t.id)).toEqual(["t-priv-a"]);
  });

  it("un tournament_staff d'un tournoi ARCHIVED ne voit aucun tournoi privé de l'organisation (SEC-23)", async () => {
    state.tables.tournament_staff.push({ tournament_id: "t-archived", user_id: "u-old-staff", role: "TOURNAMENT_TO" });

    const { privateList } = await loadDiscoverableTournaments("u-old-staff", []);
    expect(privateList).toEqual([]);
  });

  it("un membre natif (MEMBER) voit tous les tournois privés non archivés de son organisation", async () => {
    state.tables.organization_members.push({ organization_id: ORG_X, user_id: "u-member", role: "MEMBER" });

    const { privateList } = await loadDiscoverableTournaments("u-member", []);
    expect(privateList.map((t) => t.id)).toEqual(["t-priv-a", "t-priv-b"]);
  });

  it("un membre Discord ne voit les tournois privés que si l'intégration Discord est active (SEC-26)", async () => {
    const { privateList } = await loadDiscoverableTournaments("u-discord", ["guild-x", "guild-y"]);
    expect(privateList.map((t) => t.id)).toEqual(["t-priv-a", "t-priv-b"]);
  });
});

describe("loadOrganizationHubTournaments (AUD-SEC-02 / SEC-10 / SEC-21)", () => {
  it("un staff de niveau TOURNAMENT sur le tournoi A ne voit que les publics + le tournoi privé A (jamais B)", async () => {
    const out = await loadOrganizationHubTournaments({
      organizationId: ORG_X,
      viewerDiscordId: "u-staff",
      isActiveDiscordMember: false,
      access: {
        allowed: true,
        access: {
          level: "TOURNAMENT",
          tournamentIds: ["t-priv-a"],
          tournamentRoles: { "t-priv-a": "TOURNAMENT_TO" },
          source: "NATIVE",
        },
      },
    });

    expect(out.isMember).toBe(false);
    expect(out.tournaments.map((t) => t.id)).toEqual(["t-pub", "t-priv-a"]);
  });

  it("un MEMBER natif (Web sans Discord, sans accès admin) voit les tournois privés de son organisation", async () => {
    state.tables.organization_members.push({ organization_id: ORG_X, user_id: "u-member", role: "MEMBER" });

    const out = await loadOrganizationHubTournaments({
      organizationId: ORG_X,
      viewerDiscordId: "u-member",
      isActiveDiscordMember: false,
      access: { allowed: false, reason: "NO_RIGHTS" },
    });

    expect(out.isMember).toBe(true);
    expect(out.tournaments.map((t) => t.id)).toEqual(["t-pub", "t-priv-a", "t-priv-b"]);
  });

  it("un visiteur externe ne voit que les tournois publics", async () => {
    const out = await loadOrganizationHubTournaments({
      organizationId: ORG_X,
      viewerDiscordId: null,
      isActiveDiscordMember: false,
      access: { allowed: false, reason: "NOT_LOGGED_IN" },
    });

    expect(out.isMember).toBe(false);
    expect(out.tournaments.map((t) => t.id)).toEqual(["t-pub"]);
  });
});
