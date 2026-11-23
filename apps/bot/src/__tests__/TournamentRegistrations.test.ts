import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/IntegrationBus", () => ({
  IntegrationBus: { emit: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyTournamentGuild: () => Promise.resolve(true),
  resolveOrganization: () => Promise.resolve({ id: "org-1" }),
}));

import { supabase } from "../lib/supabase";
import { IntegrationBus } from "../services/IntegrationBus";
import { tournamentRouter } from "../routes/TournamentRouter";
import { callRoute } from "./helpers/route";

const TID = "00000000-0000-0000-0000-000000000001";
let updates: unknown[];

function db(tournament: Record<string, unknown>, updateError: { message: string } | null = null) {
  updates = [];
  vi.mocked(supabase.from).mockImplementation((() => {
    let op = "select";
    const b = {
      select: () => b,
      eq: () => b,
      update: (payload: unknown) => ((op = "update"), updates.push(payload), b),
      single: () => Promise.resolve({ data: tournament, error: null }),
      then: (resolve: (r: unknown) => unknown) =>
        resolve(op === "update" ? { data: null, error: updateError } : { data: tournament, error: null }),
    };
    return b;
  }) as unknown as typeof supabase.from);
}

const open = () =>
  callRoute(tournamentRouter, {
    method: "POST",
    path: `/${TID}/registrations`,
    body: { action: "open", guildId: "111" },
    adminCheck: { discordId: "u1", guildId: "111", access: { level: "SERVER", reason: "TO_ROLE" } },
    locals: { discordClient: {} },
  });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/tournaments/:id/registrations (open)", () => {
  it("REG-08: ouvre les inscriptions en base puis notifie les intégrations", async () => {
    db({ status: "DRAFT", is_public: false, start_at: null, start_date: null, checkin_start_at: null });
    const out = await open();
    expect(out.status).toBe(200);
    expect(updates).toEqual([{ is_registration_open: true }]);
    expect(IntegrationBus.emit).toHaveBeenCalledWith("onRegistrationOpened", { organizationId: "org-1", tournamentId: TID, discordClient: {} });
  });

  it("REG-01: refuse l'ouverture une fois le check-in commencé", async () => {
    db({ status: "REGISTRATION", is_public: true, checkin_start_at: "2000-01-01T00:00:00Z" });
    const out = await open();
    expect(out.status).toBe(400);
    expect(updates).toEqual([]);
    expect(IntegrationBus.emit).not.toHaveBeenCalled();
  });

  it("REG-08: une annonce Discord en échec n'empêche pas l'ouverture et devient un avertissement", async () => {
    db({ status: "DRAFT", is_public: true });
    vi.mocked(IntegrationBus.emit).mockResolvedValueOnce([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);
    const out = await open();
    expect(out.status).toBe(200);
    expect(updates).toEqual([{ is_registration_open: true }]);
    expect(out.body).toMatchObject({ integrationWarnings: [{ provider: "DISCORD", code: "INTEGRATION_FAILED" }] });
  });

  it("REG-08: une erreur d'écriture du flag est remontée (pas de succès silencieux)", async () => {
    db({ status: "DRAFT", is_public: true }, { message: "write failed" });
    const out = await open();
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});
