import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/GuildRegistryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/GuildRegistryService")>()),
  GuildRegistryService: { syncGuildAdmins: vi.fn().mockResolvedValue(true) },
}));

import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { GuildRegistryService } from "../services/GuildRegistryService";
import { serverSettingsRouter } from "../routes/ServerSettingsRouter";
import { callRoute } from "./helpers/route";

const GUILD = "111";
let upserted: unknown;

function db(opts: { currentToRole?: string | null; upsertError?: { message: string } } = {}) {
  upserted = undefined;
  vi.mocked(supabase.from).mockImplementation((() => {
    let op = "select";
    const b = {
      select: () => b,
      eq: () => b,
      upsert: (payload: unknown) => ((op = "upsert"), (upserted = payload), b),
      maybeSingle: () => Promise.resolve({ data: opts.currentToRole === undefined ? null : { to_role_id: opts.currentToRole }, error: null }),
      single: () =>
        Promise.resolve(op === "upsert" && opts.upsertError ? { data: null, error: opts.upsertError } : { data: upserted, error: null }),
    };
    return b;
  }) as unknown as typeof supabase.from);
}

const guild = { id: GUILD };
function put(body: Record<string, unknown>) {
  return callRoute(serverSettingsRouter, {
    method: "PUT",
    path: "/",
    body,
    adminCheck: { discordId: "u1", guildId: GUILD, reason: "ADMINISTRATOR" },
    locals: { discordClient: { guilds: { fetch: () => Promise.resolve(guild) } } },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/server-settings", () => {
  it("SEC-08: refuse la modification d'un autre serveur", async () => {
    db();
    const out = await put({ guild_id: "222" });
    expect(out.status).toBe(403);
  });

  it("refuse une invitation qui n'est pas un lien Discord", async () => {
    db();
    const out = await put({ guild_id: GUILD, invite_url: "https://evil.example/abc" });
    expect(out.status).toBe(400);
    expect(upserted).toBeUndefined();
  });

  it("enregistre une invitation Discord valide et ne réécrit pas la langue absente du corps", async () => {
    db({ currentToRole: null });
    const out = await put({ guild_id: GUILD, invite_url: "https://discord.gg/abc-123" });
    expect(out.status).toBe(200);
    expect(upserted).toMatchObject({ guild_id: GUILD, invite_url: "https://discord.gg/abc-123" });
    expect(upserted).not.toHaveProperty("language");
  });

  it("DISC-08: un changement de rôle TO resynchronise guild_admins", async () => {
    db({ currentToRole: "1" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(GuildRegistryService.syncGuildAdmins).toHaveBeenCalledWith(guild);
  });

  it("DISC-08: un rôle TO inchangé ne déclenche pas de resynchronisation", async () => {
    db({ currentToRole: "2" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(GuildRegistryService.syncGuildAdmins).not.toHaveBeenCalled();
  });

  it("une erreur Supabase est journalisée et renvoyée en 500, sans resynchronisation", async () => {
    db({ currentToRole: "1", upsertError: { message: "boom" } });
    const out = await put({ guild_id: GUILD, to_role_id: "2" });
    expect(out.status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
    expect(GuildRegistryService.syncGuildAdmins).not.toHaveBeenCalled();
  });
});
