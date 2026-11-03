import { beforeEach, describe, expect, it, vi } from "vitest";

// SEC-19 : les refus métier des générateurs et de la synchronisation Discord sont des DomainError
// (statut 4xx + message destiné au TO), pas des erreurs techniques masquées en 500 générique.

type Result = { data: unknown; error: null };
interface Chain extends PromiseLike<Result> {
  select: () => Chain;
  eq: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  delete: () => Chain;
  single: () => Promise<Result>;
}

function chain(data: unknown): Chain {
  const result: Result = { data, error: null };
  const builder: Chain = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    delete: () => builder,
    single: async () => result,
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyPhaseGuild: vi.fn(async () => true),
  verifyTournamentGuild: vi.fn(async () => true),
}));

import { DomainError } from "../utils/serverError";
import { BracketGeneratorService } from "../services/BracketGeneratorService";
import { RoundRobinGeneratorService } from "../services/RoundRobinGeneratorService";
import { LifecycleService } from "../services/LifecycleService";
import { phaseRouter } from "../routes/PhaseRouter";
import { callRoute } from "./helpers/route";
import type { Client } from "discord.js";

function tables(rows: Record<string, unknown>) {
  db.from.mockImplementation((table: string) => {
    if (!(table in rows)) throw new Error(`unexpected table ${table}`);
    return chain(rows[table]);
  });
}

const discordClient = {} as Client;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("SEC-19 — refus métier typés DomainError", () => {
  it("SEC-19: poules plus nombreuses que les équipes ➜ DomainError 400", async () => {
    tables({ phase_teams: [{ team_id: "t1", seed: 1 }], groups: null });
    const run = RoundRobinGeneratorService.generateGroups("p-1", 3);
    await expect(run).rejects.toBeInstanceOf(DomainError);
    await expect(run).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Cannot create 3 groups with only 1 teams") });
  });

  it("SEC-19: seed en double ➜ DomainError 409", async () => {
    tables({ phases: { format: "SINGLE_ELIM" }, phase_teams: [{ team_id: "t1", seed: 1 }, { team_id: "t2", seed: -1 }] });
    const run = BracketGeneratorService.generateBracket("p-1", 4);
    await expect(run).rejects.toBeInstanceOf(DomainError);
    await expect(run).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Duplicate seed") });
  });

  it.each(["SINGLE_ELIM", "DOUBLE_ELIM"])("SEC-19: %s, matchs déjà générés ➜ DomainError 409", async (format) => {
    tables({ phases: { format }, phase_teams: [{ team_id: "t1", seed: 1 }, { team_id: "t2", seed: 2 }], matches: [{ id: "m-1" }] });
    const run = BracketGeneratorService.generateBracket("p-1", 4);
    await expect(run).rejects.toBeInstanceOf(DomainError);
    await expect(run).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Matches already exist") });
  });

  it("SEC-19: synchronisation sans catégorie Discord ➜ DomainError 409", async () => {
    tables({ phases: { tournaments: { id: "t-1", discord_category_id: null }, groups: [] } });
    const run = LifecycleService.syncPhaseChannels("p-1", "111", discordClient);
    await expect(run).rejects.toBeInstanceOf(DomainError);
    await expect(run).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Please launch the tournament first") });
  });

  it("SEC-19: POST /api/phases/:id/sync relaie le refus métier au TO (409 + message)", async () => {
    tables({ phases: { tournaments: { id: "t-1", discord_category_id: null }, groups: [] } });
    const out = await callRoute(phaseRouter, {
      method: "POST", path: "/p-1/sync", body: { guildId: "111" }, locals: { discordClient },
    });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "Tournament does not have an active Discord Category. Please launch the tournament first." });
  });
});
