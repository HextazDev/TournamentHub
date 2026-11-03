import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: vi.fn(() => "guild-1"),
  verifyPhaseGuild: vi.fn(async () => true),
  verifyTournamentGuild: vi.fn(async () => true),
}));
vi.mock("../services/BracketGeneratorService", () => ({ BracketGeneratorService: {} }));
vi.mock("../services/RoundRobinGeneratorService", () => ({ RoundRobinGeneratorService: {} }));
vi.mock("../services/LifecycleService", () => ({ LifecycleService: {} }));

import express from "express";
import { supabase } from "../lib/supabase";
import { verifyPhaseGuild } from "../utils/tenant";
import { phaseRouter } from "../routes/PhaseRouter";

let server: Server;
let baseUrl: string;
let updatePayloads: unknown[] = [];

function mockPhaseUpdate() {
  vi.mocked(supabase.from).mockImplementation((() => {
    const builder = {
      update: (payload: unknown) => {
        updatePayloads.push(payload);
        return builder;
      },
      eq: () => builder,
      select: () => builder,
      single: () => Promise.resolve({ data: { id: "phase-1" }, error: null }),
    };
    return builder;
  }) as unknown as typeof supabase.from);
}

function put(body: unknown) {
  return fetch(`${baseUrl}/api/phases/phase-1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/phases", phaseRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PUT /api/phases/:id — PH-01 validation du barème", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updatePayloads = [];
    mockPhaseUpdate();
  });

  it("PH-01: barème valide ➜ 200 et settings enregistrés tels quels", async () => {
    const settings = { points_win: 3, points_draw: 1, points_loss: 0, points_forfeit: -1 };
    const res = await put({ name: "Poules", settings });
    expect(res.status).toBe(200);
    expect(updatePayloads).toEqual([{ name: "Poules", settings }]);
  });

  it("PH-01: points_win vide (\"\") ➜ 400 et aucune écriture", async () => {
    const res = await put({ settings: { points_win: "", points_draw: 1, points_loss: 0, points_forfeit: 0 } });
    expect(res.status).toBe(400);
    expect(updatePayloads).toEqual([]);
  });

  it("PH-01: settings non-objet ➜ 400 et aucune écriture", async () => {
    const res = await put({ settings: "3/1/0/0" });
    expect(res.status).toBe(400);
    expect(updatePayloads).toEqual([]);
  });

  it("SEC: phase d'un autre serveur ➜ 403 avant toute validation ou écriture", async () => {
    vi.mocked(verifyPhaseGuild).mockResolvedValueOnce(false);
    const res = await put({ settings: { points_win: "" } });
    expect(res.status).toBe(403);
    expect(updatePayloads).toEqual([]);
  });
});
