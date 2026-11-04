import { beforeEach, describe, expect, it, vi } from "vitest";

type DbResult = { data: unknown; error: { code?: string; message: string } | null };

const db = vi.hoisted(() => ({ from: vi.fn() }));
const presence = vi.hoisted(() => ({ applyPresence: vi.fn(), removePresence: vi.fn() }));
const tenant = vi.hoisted(() => ({ verifyTournamentGuild: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../services/CaptainPresenceService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/CaptainPresenceService")>()),
  applyPresence: presence.applyPresence,
  removePresence: presence.removePresence,
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  getTournamentScope: (req: { tournamentScope?: { tournamentId: string } }) => req.tournamentScope?.tournamentId ?? null,
  verifyTeamGuild: vi.fn(),
  verifyTournamentGuild: tenant.verifyTournamentGuild,
}));

import { MAX_FAKE_TEAMS } from "@hub/shared";
import { teamRouter } from "../routes/TeamRouter";
import { callRoute } from "./helpers/route";

const TOURNAMENT_ID = "6f1c2a6e-3b7d-4c8e-9f10-112233445566";
const CAPTAIN = "123456789012345678";
const client = { marker: "discord-client" };
const adminCheck = { discordId: "to", guildId: "111", access: { level: "SERVER", reason: "TO_ROLE" } } as const;

interface Tables {
  tournament: DbResult;
  team: DbResult;
  members: DbResult;
}

let tables: Tables;
const inserted: { teams: unknown[]; members: unknown[] } = { teams: [], members: [] };

function wireDb() {
  db.from.mockImplementation((table: string) => {
    if (table === "tournaments") {
      return { select: () => ({ eq: () => ({ single: async () => tables.tournament }) }) };
    }
    if (table === "teams") {
      return {
        insert: (row: unknown) => {
          inserted.teams.push(row);
          return { select: () => ({ single: async () => tables.team }) };
        },
      };
    }
    if (table === "team_members") {
      return {
        insert: (rows: unknown) => {
          inserted.members.push(rows);
          return { select: async () => tables.members };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const teamRow = (is_checked_in: boolean) => ({
  id: "team-1", tournament_id: TOURNAMENT_ID, name: "Les Bolides", captain_discord_id: CAPTAIN, is_checked_in,
});

function tournamentIs(status: string, checkin_start_at: string | null) {
  tables.tournament = { data: { status, checkin_start_at }, error: null };
}

const body = (extra: Record<string, unknown> = {}) => ({
  tournament_id: TOURNAMENT_ID,
  guildId: "111",
  name: "Les Bolides",
  captain_discord_id: CAPTAIN,
  members: [{ user_id: CAPTAIN, ingame_name: "Cap", friend_code: "SW-1234-5678-9012", is_captain: true }],
  ...extra,
});

const post = (payload: unknown) => callRoute(teamRouter, {
  method: "POST", path: "/", body: payload, adminCheck, locals: { discordClient: client },
});

const PAST = "2000-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  inserted.teams = [];
  inserted.members = [];
  tenant.verifyTournamentGuild.mockResolvedValue(true);
  presence.applyPresence.mockResolvedValue({ status: "done", nickname: "applied", role: "applied" });
  tables = {
    tournament: { data: { status: "REGISTRATION", checkin_start_at: PAST }, error: null },
    team: { data: teamRow(true), error: null },
    members: { data: [{ id: "m-1", team_id: "team-1" }], error: null },
  };
  wireDb();
});

describe("POST /api/teams — REG-09 validation", () => {
  it.each([
    ["nom vide", body({ name: "" })],
    ["capitaine absent", body({ captain_discord_id: undefined })],
    ["membres malformés", body({ members: [{ ingame_name: 42 }] })],
    ["tournament_id invalide", body({ tournament_id: "t-1" })],
  ])("REG-09: %s ➜ 400 sans écriture ni Discord", async (_label, payload) => {
    const out = await post(payload);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: expect.any(String) });
    expect(db.from).not.toHaveBeenCalled();
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("SEC: tournoi d'un autre serveur ➜ 403 sans écriture ni Discord", async () => {
    tenant.verifyTournamentGuild.mockResolvedValue(false);
    const out = await post(body());
    expect(out.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("tournoi introuvable ➜ 404 sans écriture", async () => {
    tables.tournament = { data: null, error: { message: "not found" } };
    const out = await post(body());
    expect(out.status).toBe(404);
    expect(inserted.teams).toHaveLength(0);
  });
});

describe("POST /api/teams — REG-09 check-in par défaut", () => {
  it("REG-09: check-in ouvert ➜ équipe check-in", async () => {
    tournamentIs("REGISTRATION", PAST);
    await post(body());
    expect(inserted.teams[0]).toMatchObject({ is_checked_in: true, captain_discord_id: CAPTAIN, name: "Les Bolides" });
  });

  it("REG-09: tournoi lancé ➜ équipe check-in", async () => {
    tournamentIs("ACTIVE", null);
    await post(body());
    expect(inserted.teams[0]).toMatchObject({ is_checked_in: true });
  });

  it("REG-09: inscriptions avant le check-in ➜ non check-in, aucun appel Discord", async () => {
    tournamentIs("REGISTRATION", FUTURE);
    tables.team = { data: teamRow(false), error: null };
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(inserted.teams[0]).toMatchObject({ is_checked_in: false });
    expect(presence.applyPresence).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ presence_warning: false });
  });

  it("REG-09: is_checked_in explicite prime sur la règle", async () => {
    tournamentIs("REGISTRATION", FUTURE);
    await post(body({ is_checked_in: true }));
    expect(inserted.teams[0]).toMatchObject({ is_checked_in: true });
  });

  it("REG-09: checkin_mode === DISABLED ➜ équipe check-in par défaut même avec checkin_start_at futur ou nul", async () => {
    tables.tournament = { data: { status: "REGISTRATION", checkin_start_at: FUTURE, checkin_mode: "DISABLED" }, error: null };
    await post(body());
    expect(inserted.teams[0]).toMatchObject({ is_checked_in: true });
  });
});

describe("POST /api/teams — DISC-12 présence à la création", () => {
  it("DISC-12: équipe créée check-in ➜ applyPresence avec l'équipe insérée", async () => {
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(presence.applyPresence).toHaveBeenCalledWith(expect.objectContaining(client), {
      id: "team-1", tournament_id: TOURNAMENT_ID, name: "Les Bolides", captain_discord_id: CAPTAIN,
    });
    expect(out.body).toMatchObject({ id: "team-1", presence_warning: false, team_members: [{ id: "m-1" }] });
    expect(inserted.members[0]).toEqual([
      { team_id: "team-1", user_id: CAPTAIN, ingame_name: "Cap", friend_code: "SW-1234-5678-9012", is_captain: true },
    ]);
  });

  it("DISC-12: capitaine absent du serveur ➜ 201 + presence_warning", async () => {
    presence.applyPresence.mockResolvedValue({ status: "skipped", reason: "member_unavailable" });
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ id: "team-1", presence_warning: true });
  });

  it.each([
    ["nouveau format 000000", "000000123456789012"],
    ["ancien format 999999", "999999123456789012"],
  ])("DISC-12: capitaine synthétique sans compte Discord (%s) ➜ aucun appel Discord et presence_warning faux", async (_label, synthCaptain) => {
    tables.team = { data: { ...teamRow(true), captain_discord_id: synthCaptain }, error: null };
    const out = await post(body({ captain_discord_id: synthCaptain }));
    expect(out.status).toBe(201);
    expect(presence.applyPresence).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ presence_warning: false });
  });

  it("DISC-12: rôle au-dessus du bot ➜ 201 + presence_warning", async () => {
    presence.applyPresence.mockResolvedValue({ status: "done", nickname: "applied", role: "above_bot" });
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ presence_warning: true });
  });

  it("capitaine déjà inscrit / nom pris (23505) ➜ 409 sans Discord", async () => {
    tables.team = { data: null, error: { code: "23505", message: "duplicate key" } };
    const out = await post(body());
    expect(out.status).toBe(409);
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("échec d'écriture de l'équipe ➜ 500 sans Discord", async () => {
    tables.team = { data: null, error: { message: "db down" } };
    const out = await post(body());
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });
});

describe("POST /api/teams/generate-fake — REG-07", () => {
  it("REG-07: les équipes fictives ne déclenchent aucun appel Discord", async () => {
    const fakeTeams = [teamRow(true), { ...teamRow(true), id: "team-2" }];
    db.from.mockImplementation((table: string) => {
      if (table === "teams") return { insert: () => ({ select: async () => ({ data: fakeTeams, error: null }) }) };
      if (table === "team_members") return { insert: () => ({ select: async () => ({ data: [], error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
    const out = await callRoute(teamRouter, {
      method: "POST", path: "/generate-fake", body: { tournament_id: TOURNAMENT_ID, count: 2, guildId: "111" },
      adminCheck, locals: { discordClient: client },
    });
    expect(out.status).toBe(201);
    expect(presence.applyPresence).not.toHaveBeenCalled();
    expect(presence.removePresence).not.toHaveBeenCalled();
  });
});

describe("POST /api/teams/generate-fake — PH-02/REG-07 validation du corps", () => {
  const fakeInserts: unknown[][] = [];

  beforeEach(() => {
    fakeInserts.length = 0;
    db.from.mockImplementation((table: string) => {
      if (table === "teams") {
        return {
          insert: (rows: unknown[]) => {
            fakeInserts.push(rows);
            return { select: async () => ({ data: rows.map((r, i) => ({ ...(r as object), id: `t-${i}` })), error: null }) };
          },
        };
      }
      if (table === "team_members") return { insert: () => ({ select: async () => ({ data: [], error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
  });

  const generate = (payload: unknown) => callRoute(teamRouter, {
    method: "POST", path: "/generate-fake", body: payload, adminCheck, locals: { discordClient: client },
  });

  it.each([
    ["tournament_id absent", { count: 2 }],
    ["tournament_id non UUID", { tournament_id: "abc", count: 2 }],
    ["count absent", { tournament_id: TOURNAMENT_ID }],
    ["count nul", { tournament_id: TOURNAMENT_ID, count: 0 }],
    ["count négatif", { tournament_id: TOURNAMENT_ID, count: -1 }],
    ["count chaîne", { tournament_id: TOURNAMENT_ID, count: "5" }],
    ["count décimal", { tournament_id: TOURNAMENT_ID, count: 2.5 }],
  ])("REG-07: %s ➜ 400 sans vérification de tenant ni écriture", async (_label, payload) => {
    const out = await generate(payload);
    expect(out.status).toBe(400);
    expect(tenant.verifyTournamentGuild).not.toHaveBeenCalled();
    expect(fakeInserts).toEqual([]);
  });

  it("REG-07: count au-delà du plafond ➜ plafonné à MAX_FAKE_TEAMS (pas de 400)", async () => {
    const out = await generate({ tournament_id: TOURNAMENT_ID, count: 1000, guildId: "111" });
    expect(out.status).toBe(201);
    expect(fakeInserts).toHaveLength(1);
    expect(fakeInserts[0]).toHaveLength(MAX_FAKE_TEAMS);
    expect(tenant.verifyTournamentGuild).toHaveBeenCalledWith(TOURNAMENT_ID, "111");
  });

  it("SEC-01: tournoi d'un autre serveur ➜ 403 sans écriture", async () => {
    tenant.verifyTournamentGuild.mockResolvedValue(false);
    const out = await generate({ tournament_id: TOURNAMENT_ID, count: 2 });
    expect(out.status).toBe(403);
    expect(fakeInserts).toEqual([]);
  });
});
