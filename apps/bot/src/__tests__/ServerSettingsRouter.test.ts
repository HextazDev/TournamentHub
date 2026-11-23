import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GuildAdminReason } from "@hub/shared";

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
vi.mock("../services/MemberAccessService", () => ({ invalidateGuildAccess: vi.fn() }));

import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { GuildRegistryService } from "../services/GuildRegistryService";
import { invalidateGuildAccess } from "../services/MemberAccessService";
import { serverSettingsRouter } from "../routes/ServerSettingsRouter";
import { callRoute } from "./helpers/route";

const GUILD = "111";
let updatedIntegrationConfig: Record<string, unknown> | undefined;
let updatedOrg: Record<string, unknown> | undefined;

function db(opts: { currentToRole?: string | null; updateError?: { message: string } } = {}) {
  updatedIntegrationConfig = undefined;
  updatedOrg = undefined;
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const currentTable = table;
    const b = {
      select: () => b,
      eq: () => b,
      update: (payload: Record<string, unknown>) => {
        if (currentTable === "organization_integrations") {
          updatedIntegrationConfig = payload.config as Record<string, unknown>;
        } else if (currentTable === "organizations") {
          updatedOrg = payload;
        }
        return b;
      },
      maybeSingle: () => {
        if (currentTable === "organization_integrations") {
          const cfg =
            opts.currentToRole !== undefined && opts.currentToRole !== null
              ? { to_role_id: opts.currentToRole }
              : {};
          return Promise.resolve({
            data: {
              organization_id: "org-1",
              config: cfg,
              provider: "DISCORD",
              external_id: GUILD,
              enabled: true,
            },
            error: null,
          });
        }
        if (currentTable === "organizations") {
          return Promise.resolve({
            data: {
              id: "org-1",
              slug: "guild-111",
              name: "Guild 111",
              language: "fr",
              invite_url: null,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (val: unknown) => unknown) => {
        if (opts.updateError) {
          return Promise.resolve(resolve({ data: null, error: opts.updateError }));
        }
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return b;
  }) as unknown as typeof supabase.from);
}

const guild = { id: GUILD };
function put(body: Record<string, unknown>, reason: GuildAdminReason = "ADMINISTRATOR") {
  return callRoute(serverSettingsRouter, {
    method: "PUT",
    path: "/",
    body,
    adminCheck: { discordId: "u1", guildId: GUILD, access: { level: "SERVER", reason } },
    locals: { discordClient: { guilds: { fetch: () => Promise.resolve(guild) } } },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/server-settings", () => {
  it("SEC-16: un membre du rôle TO ne peut pas modifier les paramètres du serveur (dont to_role_id)", async () => {
    db({ currentToRole: "1" });
    const out = await put({ guild_id: GUILD, to_role_id: "2" }, "TO_ROLE");
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "SERVER_SETTINGS_RESERVED" });
    expect(updatedIntegrationConfig).toBeUndefined();
    expect(GuildRegistryService.syncGuildAdmins).not.toHaveBeenCalled();
  });

  it.each(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD"] as const)(
    "SEC-16: %s peut modifier les paramètres du serveur",
    async (reason) => {
      db({ currentToRole: "1" });
      const out = await put({ guild_id: GUILD, to_role_id: "2" }, reason);
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ guild_id: GUILD, to_role_id: "2" });
      expect(updatedIntegrationConfig).toMatchObject({ to_role_id: "2" });
    },
  );

  it("SEC-08: refuse la modification d'un autre serveur", async () => {
    db();
    const out = await put({ guild_id: "222" });
    expect(out.status).toBe(403);
  });

  it("refuse une invitation qui n'est pas un lien Discord", async () => {
    db();
    const out = await put({ guild_id: GUILD, invite_url: "https://evil.example/abc" });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Invitation Discord invalide" });
    expect(updatedIntegrationConfig).toBeUndefined();
  });

  it("SEC-08: refuse un identifiant de rôle ou de salon qui n'est pas un ID Discord, avec un message explicite", async () => {
    db();
    const out = await put({ guild_id: GUILD, to_role_id: "abc" });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Identifiant Discord invalide" });
    expect(updatedIntegrationConfig).toBeUndefined();
  });

  it("enregistre une invitation Discord valide et ne réécrit pas la langue absente du corps", async () => {
    db({ currentToRole: null });
    const out = await put({ guild_id: GUILD, invite_url: "https://discord.gg/abc-123" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ guild_id: GUILD, invite_url: "https://discord.gg/abc-123" });
    expect(updatedOrg).toMatchObject({ invite_url: "https://discord.gg/abc-123" });
    expect(updatedOrg).not.toHaveProperty("language");
  });

  it("DISC-08: un changement de rôle TO resynchronise guild_admins", async () => {
    db({ currentToRole: "1" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(GuildRegistryService.syncGuildAdmins).toHaveBeenCalledWith(guild);
  });

  it("SEC-05: un changement de rôle TO invalide le cache d'accès du serveur (nouveaux TO admis, anciens refusés)", async () => {
    db({ currentToRole: "1" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(invalidateGuildAccess).toHaveBeenCalledWith(GUILD);
  });

  it("SEC-05: un rôle TO inchangé ne vide pas le cache d'accès", async () => {
    db({ currentToRole: "2" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(invalidateGuildAccess).not.toHaveBeenCalled();
  });

  it("DISC-08: un rôle TO inchangé ne déclenche pas de resynchronisation", async () => {
    db({ currentToRole: "2" });
    await put({ guild_id: GUILD, to_role_id: "2" });
    expect(GuildRegistryService.syncGuildAdmins).not.toHaveBeenCalled();
  });

  it("une erreur Supabase est journalisée et renvoyée en 500, sans resynchronisation", async () => {
    db({ currentToRole: "1", updateError: { message: "boom" } });
    const out = await put({ guild_id: GUILD, to_role_id: "2" });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { message: "boom" });
    expect(GuildRegistryService.syncGuildAdmins).not.toHaveBeenCalled();
  });
});
