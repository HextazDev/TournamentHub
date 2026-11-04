import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const db = vi.hoisted(() => ({ from: vi.fn() }));
const verify = vi.hoisted(() => vi.fn());
const cleanup = vi.hoisted(() => vi.fn());
const schedule = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/tenant", () => ({
  verifyTournamentGuild: verify,
  getAuthenticatedGuildId: (req: Request) => req.adminCheck?.guildId ?? null,
  getTournamentScope: (req: Request) => req.tournamentScope?.tournamentId ?? null,
}));
vi.mock("../services/ArchiveService", () => ({ ArchiveService: { backgroundDiscordCleanup: cleanup } }));
vi.mock("../services/SchedulerService", () => ({ SchedulerService: { scheduleTournament: schedule } }));
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn() } }));
import { archiveAndInit, syncSchedule } from "../routes/LifecycleRouter";

const response = () => {
  const out = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; } };
  return out;
};
beforeEach(() => { vi.clearAllMocks(); });

describe("SEC-14 lifecycle tenant isolation", () => {
  it("rejects archive across guilds before writes, cleanup, or scheduling", async () => {
    verify.mockResolvedValue(false);
    const req = { body: { guildId: "a", newTournamentId: "b-tournament" }, adminCheck: { guildId: "a" }, app: { locals: {} } } as Request;
    const res = response();
    await archiveAndInit(req, res as unknown as Response);
    expect(res.statusCode).toBe(403);
    expect(verify).toHaveBeenCalledWith("b-tournament", "a");
    expect(db.from).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
  it("rejects cross-guild schedule before reading or scheduling", async () => {
    verify.mockResolvedValue(false);
    const req = { body: { tournament_id: "b-tournament" }, tournamentScope: { tournamentId: "b-tournament" }, adminCheck: { guildId: "a" } } as Request;
    const res = response();
    await syncSchedule(req, res as unknown as Response);
    expect(res.statusCode).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
  it("rejects missing target before any database operation", async () => {
    const req = { body: { guildId: "a" }, adminCheck: { guildId: "a" } } as Request;
    const res = response();
    await archiveAndInit(req, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });
  it("allows archive for an owned tournament and scopes the read and write", async () => {
    verify.mockResolvedValue(true);
    const filters: string[][] = [];
    const tournament = { id: "t1", guild_id: "a" };
    const archivedRow = { id: "t-old", discord_captain_role_id: "r", discord_checkin_channel_id: "c" };
    const chain = {
      select: () => chain, update: () => chain,
      eq: (key: string, value: string) => { filters.push([key, value]); return chain; },
      neq: () => chain,
      single: async () => ({ data: tournament, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: [archivedRow], error: null }),
    };
    db.from.mockReturnValue(chain);
    cleanup.mockResolvedValue(undefined);
    const req = { body: { guildId: "a", newTournamentId: "t1" }, adminCheck: { guildId: "a" }, app: { locals: { discordClient: {} } } } as unknown as Request;
    const res = response();
    await archiveAndInit(req, res as unknown as Response);
    expect(res.statusCode).toBe(202);
    expect(filters).toContainEqual(["guild_id", "a"]);
    expect(schedule).toHaveBeenCalledWith(tournament);
    expect(cleanup).toHaveBeenCalledWith(expect.anything(), "a", [archivedRow]);
  });

  it("ne déclenche pas backgroundDiscordCleanup si aucun autre tournoi n'a été archivé", async () => {
    verify.mockResolvedValue(true);
    const tournament = { id: "t1", guild_id: "a" };
    const chain = {
      select: () => chain, update: () => chain,
      eq: () => chain,
      neq: () => chain,
      single: async () => ({ data: tournament, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
    };
    db.from.mockReturnValue(chain);
    cleanup.mockResolvedValue(undefined);
    const req = { body: { guildId: "a", newTournamentId: "t1" }, adminCheck: { guildId: "a" }, app: { locals: { discordClient: {} } } } as unknown as Request;
    const res = response();
    await archiveAndInit(req, res as unknown as Response);
    expect(res.statusCode).toBe(202);
    expect(schedule).toHaveBeenCalledWith(tournament);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
