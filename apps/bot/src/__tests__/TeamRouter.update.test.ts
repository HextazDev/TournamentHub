import { beforeEach, describe, expect, it, vi } from "vitest";

type DbError = { code?: string; message: string };
type DbResult = { data: unknown; error: DbError | null };

const db = vi.hoisted(() => ({ from: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const tenant = vi.hoisted(() => ({ verifyTeamGuild: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: log }));
vi.mock("../services/CaptainPresenceService", () => ({
  applyPresence: vi.fn(),
  removePresence: vi.fn(),
  hasPresenceFailure: vi.fn(),
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyTeamGuild: tenant.verifyTeamGuild,
  verifyTournamentGuild: vi.fn(),
}));

import { TEAM_MEMBERS_MAX, TEAM_NAME_MAX_LENGTH } from "@hub/shared";
import { teamRouter } from "../routes/TeamRouter";
import { callRoute } from "./helpers/route";

const TEAM_ID = "team-1";
const CAPTAIN = "123456789012345678";
const adminCheck = { discordId: "to", guildId: "111", access: { level: "SERVER", reason: "TO_ROLE" } } as const;
const INTERNAL_DETAIL = 'duplicate key value violates unique constraint "unique_captain_per_tournament"';

interface Writes {
  teamUpdates: unknown[];
  memberDeletes: number;
  memberInserts: unknown[];
}

let writes: Writes;
let teamResult: DbResult;
let deleteResult: { error: DbError | null };
let insertResult: DbResult;

function wireDb() {
  db.from.mockImplementation((table: string) => {
    if (table === "teams") {
      return {
        update: (row: unknown) => {
          writes.teamUpdates.push(row);
          return { eq: () => ({ select: () => ({ single: async () => teamResult }) }) };
        },
      };
    }
    if (table === "team_members") {
      return {
        delete: () => ({
          eq: async () => {
            writes.memberDeletes += 1;
            return deleteResult;
          },
        }),
        insert: (rows: unknown) => {
          writes.memberInserts.push(rows);
          return { select: async () => insertResult };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const member = (extra: Record<string, unknown> = {}) => ({
  user_id: CAPTAIN, ingame_name: "Cap", friend_code: "SW-1234-5678-9012", is_captain: true, ...extra,
});

const body = (extra: Record<string, unknown> = {}) => ({
  guildId: "111",
  name: "Les Bolides",
  captain_discord_id: CAPTAIN,
  members: [member()],
  ...extra,
});

const put = (payload: unknown) => callRoute(teamRouter, { method: "PUT", path: `/${TEAM_ID}`, body: payload, adminCheck });

beforeEach(() => {
  vi.clearAllMocks();
  writes = { teamUpdates: [], memberDeletes: 0, memberInserts: [] };
  tenant.verifyTeamGuild.mockResolvedValue(true);
  teamResult = { data: { id: TEAM_ID, name: "Les Bolides", captain_discord_id: CAPTAIN }, error: null };
  deleteResult = { error: null };
  insertResult = { data: [{ id: "m-1", team_id: TEAM_ID }], error: null };
  wireDb();
});

describe("PUT /api/teams/:id — REG-10 validation du corps", () => {
  it.each([
    ["corps vide", {}],
    ["nom absent", body({ name: undefined })],
    ["nom vide", body({ name: "   " })],
    ["nom trop long", body({ name: "x".repeat(TEAM_NAME_MAX_LENGTH + 1) })],
    ["capitaine null explicite (colonne NOT NULL)", body({ captain_discord_id: null })],
    ["capitaine non snowflake", body({ captain_discord_id: "abc" })],
    ["membre sans pseudo", body({ members: [{ friend_code: "SW-1", is_captain: false }] })],
    ["pseudo non textuel", body({ members: [member({ ingame_name: 42 })] })],
    ["user_id non snowflake", body({ members: [member({ user_id: "not-an-id" })] })],
    ["plus de 10 membres", body({ members: Array.from({ length: TEAM_MEMBERS_MAX + 1 }, () => member({ is_captain: false })) })],
    ["members non tableau", body({ members: "x" })],
  ])("REG-10: %s ➜ 400 sans écriture", async (_label, payload) => {
    const out = await put(payload);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: expect.any(String) });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("SEC: équipe d'un autre serveur ➜ 403 sans écriture (contrôle avant la validation)", async () => {
    tenant.verifyTeamGuild.mockResolvedValue(false);
    const out = await put({});
    expect(out.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("PUT /api/teams/:id — écriture", () => {
  it("REG-10: corps valide ➜ équipe mise à jour et roster remplacé (clés inconnues ignorées)", async () => {
    const out = await put(body({ name: "  Les Bolides  " }));
    expect(out.status).toBe(200);
    expect(writes.teamUpdates).toEqual([{ name: "Les Bolides", captain_discord_id: CAPTAIN }]);
    expect(writes.memberDeletes).toBe(1);
    expect(writes.memberInserts).toEqual([[{ team_id: TEAM_ID, ...member() }]]);
    expect(out.body).toMatchObject({ id: TEAM_ID, team_members: [{ id: "m-1" }] });
  });

  it("REG-10: pseudo vide accepté (parité POST)", async () => {
    const out = await put(body({ members: [member({ ingame_name: "" })] }));
    expect(out.status).toBe(200);
  });

  it("REG-10: capitaine absent ➜ inchangé ; members absent ➜ roster inchangé", async () => {
    const out = await put({ name: "Renommée" });
    expect(out.status).toBe(200);
    expect(writes.teamUpdates).toEqual([{ name: "Renommée" }]);
    expect(writes.memberDeletes).toBe(0);
    expect(writes.memberInserts).toHaveLength(0);
  });

  it("échec de suppression du roster ➜ 500 sans réinsertion", async () => {
    deleteResult = { error: { message: INTERNAL_DETAIL } };
    const out = await put(body());
    expect(out.status).toBe(500);
    expect(writes.memberInserts).toHaveLength(0);
  });

  it("SEC-19: erreur Supabase ➜ 500 générique, détail uniquement dans logger.error", async () => {
    const dbError = Object.assign(new Error(INTERNAL_DETAIL), { code: "23505" });
    teamResult = { data: null, error: dbError };
    const out = await put(body());
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(out.body)).not.toContain("unique_captain_per_tournament");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("TeamRouter"), dbError);
  });
});
