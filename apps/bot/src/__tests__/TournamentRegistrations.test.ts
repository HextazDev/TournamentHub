import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/RegistrationService", () => ({
  RegistrationService: { sendRegistrationEmbed: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyTournamentGuild: () => Promise.resolve(true),
}));

import { supabase } from "../lib/supabase";
import { RegistrationService } from "../services/RegistrationService";
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
    adminCheck: { discordId: "u1", guildId: "111", reason: "TO_ROLE" },
    locals: { discordClient: {} },
  });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/tournaments/:id/registrations (open)", () => {
  it("REG-08: un tournoi privé peut ouvrir ses inscriptions (annonce Discord + flag)", async () => {
    db({ status: "DRAFT", is_public: false, start_at: null, start_date: null, checkin_start_at: null });
    const out = await open();
    expect(out.status).toBe(200);
    expect(RegistrationService.sendRegistrationEmbed).toHaveBeenCalledWith(TID, {});
    expect(updates).toEqual([{ is_registration_open: true }]);
  });

  it("REG-01: refuse l'ouverture une fois le check-in commencé", async () => {
    db({ status: "REGISTRATION", is_public: true, checkin_start_at: "2000-01-01T00:00:00Z" });
    const out = await open();
    expect(out.status).toBe(400);
    expect(RegistrationService.sendRegistrationEmbed).not.toHaveBeenCalled();
  });

  it("REG-08: n'annonce pas un succès si l'annonce Discord échoue", async () => {
    db({ status: "DRAFT", is_public: true });
    vi.mocked(RegistrationService.sendRegistrationEmbed).mockRejectedValueOnce(new Error("Missing Access"));
    const out = await open();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "Missing Access" });
    expect(updates).toEqual([]);
  });

  it("REG-08: une erreur d'écriture du flag est remontée (pas de succès silencieux)", async () => {
    db({ status: "DRAFT", is_public: true }, { message: "write failed" });
    const out = await open();
    expect(out.status).toBe(500);
  });
});
