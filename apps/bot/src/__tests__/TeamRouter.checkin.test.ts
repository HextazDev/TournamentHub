import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ from: vi.fn() }));
const presence = vi.hoisted(() => ({ applyPresence: vi.fn(), removePresence: vi.fn() }));
const tenant = vi.hoisted(() => ({ verifyTeamGuild: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: db }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../services/CaptainPresenceService", () => presence);
vi.mock("../utils/tenant", () => ({
  getAuthenticatedGuildId: () => "111",
  verifyTeamGuild: tenant.verifyTeamGuild,
  verifyTournamentGuild: vi.fn(),
}));

import { teamRouter } from "../routes/TeamRouter";
import { callRoute } from "./helpers/route";

const client = { marker: "discord-client" };
const row = (is_checked_in: boolean, captain: string | null = "u-1") => ({
  id: "team-1", tournament_id: "t-1", name: "Team", captain_discord_id: captain, is_checked_in,
});

function dbReturns(data: unknown, error: { message: string } | null = null) {
  db.from.mockReturnValue({ update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data, error }) }) }) }) });
}

const patch = (is_checked_in: unknown) => callRoute(teamRouter, {
  method: "PATCH",
  path: "/team-1/checkin",
  body: { is_checked_in, guildId: "111" },
  adminCheck: { discordId: "to", guildId: "111", reason: "TO_ROLE" },
  locals: { discordClient: client },
});

beforeEach(() => {
  vi.clearAllMocks();
  tenant.verifyTeamGuild.mockResolvedValue(true);
  presence.applyPresence.mockResolvedValue({ status: "done", nickname: "applied", role: "applied" });
  presence.removePresence.mockResolvedValue({ status: "done", nickname: "applied", role: "applied" });
});

describe("PATCH /api/teams/:id/checkin", () => {
  it("DISC-11: applies the captain presence after a check-in", async () => {
    dbReturns(row(true));
    const out = await patch(true);
    expect(out.status).toBe(200);
    expect(presence.applyPresence).toHaveBeenCalledWith(expect.objectContaining(client), {
      id: "team-1", tournament_id: "t-1", name: "Team", captain_discord_id: "u-1",
    });
  });

  it("DISC-11: removes the captain presence after a check-out", async () => {
    dbReturns(row(false));
    await patch(false);
    expect(presence.removePresence).toHaveBeenCalledOnce();
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("DISC-11: keeps the check-in when Discord refuses the presence", async () => {
    dbReturns(row(true));
    presence.applyPresence.mockResolvedValue({ status: "done", nickname: "not_manageable", role: "above_bot" });
    const out = await patch(true);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: "team-1", is_checked_in: true });
  });

  it("does not touch Discord for a team without captain", async () => {
    dbReturns(row(true, null));
    await patch(true);
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("SEC: refuses a team from another guild before any write or Discord call", async () => {
    tenant.verifyTeamGuild.mockResolvedValue(false);
    const out = await patch(true);
    expect(out.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });

  it("does not touch Discord when the database write fails", async () => {
    dbReturns(null, { message: "db down" });
    const out = await patch(true);
    expect(out.status).toBe(500);
    expect(presence.applyPresence).not.toHaveBeenCalled();
  });
});
