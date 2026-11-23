import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/GuildRegistryService", () => ({
  GuildRegistryService: { syncGuildAdmins: vi.fn().mockResolvedValue(true) },
  readToRoleId: vi.fn().mockResolvedValue({ ok: true, toRoleId: "to-role" }),
}));
vi.mock("../services/MemberAccessService", () => ({
  invalidateGuildAccess: vi.fn(),
  refreshGuildAccess: vi.fn(),
}));

import { supabase } from "../lib/supabase";
import { tournamentRouter } from "../routes/TournamentRouter";
import { organizationRouter } from "../routes/OrganizationRouter";
import { callRoute } from "./helpers/route";
import { ChannelAccessService } from "../services/ChannelAccessService";

const GUILD = "123456789012345678";
const TOURNAMENT_ID = "tourn-abc";

describe("SEC-21 (#88): Validation des salons Discord sur les routes de mutation", () => {
  let fakeClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient = { guilds: { fetch: vi.fn().mockResolvedValue(null) } };
  });

  describe("PUT /api/tournaments/:id/settings", () => {
    function setupTournamentDb(existingChannels: {
      registration?: string | null;
      announcement?: string | null;
      checkin?: string | null;
    } = {}) {
      const orgId = "00000000-0000-0000-0000-000000000001";
      const tournament = {
        id: TOURNAMENT_ID,
        organization_id: orgId,
        status: "DRAFT",
        discord_config: {
          ...(existingChannels.registration ? { registration_channel_id: existingChannels.registration } : {}),
          ...(existingChannels.announcement ? { announcement_channel_id: existingChannels.announcement } : {}),
          ...(existingChannels.checkin ? { checkin_channel_id: existingChannels.checkin } : {}),
        },
        language: "fr",
      };

      vi.mocked(supabase.from).mockImplementation(((table: string) => {
        let rowData: any = tournament;
        if (table === "organizations") {
          rowData = { id: orgId, slug: "test-org", name: "Test Org", language: "fr" };
        } else if (table === "organization_integrations") {
          rowData = { id: "int-1", organization_id: orgId, provider: "DISCORD", external_id: GUILD, enabled: true, config: {} };
        }
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: rowData, error: null }),
          single: () => Promise.resolve({ data: rowData, error: null }),
          update: (payload: any) => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { ...tournament, ...payload }, error: null }),
              }),
            }),
          }),
        };
        return chain;
      }) as any);
    }

    it("refuse avec 403 CHANNEL_NOT_ACCESSIBLE si un salon modifié est inaccessible", async () => {
      setupTournamentDb({ registration: "chan-old" });
      const spy = vi.spyOn(ChannelAccessService, "validateChannelAccess").mockResolvedValueOnce({
        ok: false,
        code: "CHANNEL_NOT_ACCESSIBLE",
        error: "Le salon Discord (chan-private) n'est pas accessible.",
      });

      const out = await callRoute(tournamentRouter, {
        method: "PUT",
        path: `/${TOURNAMENT_ID}/settings`,
        body: {
          guildId: GUILD,
          discord_registration_channel_id: "chan-private",
        },
        adminCheck: { discordId: "to-user", guildId: GUILD, access: { level: "SERVER", reason: "TO_ROLE" } },
        locals: { discordClient: fakeClient },
      });

      expect(out.status).toBe(403);
      expect(out.body).toMatchObject({ code: "CHANNEL_NOT_ACCESSIBLE" });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        guildId: GUILD,
        discordId: "to-user",
        channelIds: ["chan-private"],
      }));
    });

    it("ne bloque pas si le salon envoyé est inchangé par rapport à la base (même si inaccessible)", async () => {
      setupTournamentDb({ registration: "chan-already-set" });
      const spy = vi.spyOn(ChannelAccessService, "validateChannelAccess");

      const out = await callRoute(tournamentRouter, {
        method: "PUT",
        path: `/${TOURNAMENT_ID}/settings`,
        body: {
          guildId: GUILD,
          discord_registration_channel_id: "chan-already-set",
          language: "en",
        },
        adminCheck: { discordId: "to-user", guildId: GUILD, access: { level: "SERVER", reason: "TO_ROLE" } },
        locals: { discordClient: fakeClient },
      });

      expect(out.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it("accepte si le salon modifié est accessible", async () => {
      setupTournamentDb({ registration: "chan-old" });
      vi.spyOn(ChannelAccessService, "validateChannelAccess").mockResolvedValueOnce({ ok: true });

      const out = await callRoute(tournamentRouter, {
        method: "PUT",
        path: `/${TOURNAMENT_ID}/settings`,
        body: {
          guildId: GUILD,
          discord_registration_channel_id: "chan-valid",
        },
        adminCheck: { discordId: "to-user", guildId: GUILD, access: { level: "SERVER", reason: "TO_ROLE" } },
        locals: { discordClient: fakeClient },
      });

      expect(out.status).toBe(200);
    });
  });

  describe("PUT /api/organizations/:orgId/integrations/DISCORD", () => {
    const ORG_ID = "00000000-0000-0000-0000-000000000001";

    function setupOrgDb(existingChannels: {
      registration?: string | null;
      announcement?: string | null;
      checkin?: string | null;
    } = {}) {
      const discordConfig = {
        to_role_id: "111111111111111111",
        registration_channel_id: existingChannels.registration ?? null,
        announcement_channel_id: existingChannels.announcement ?? null,
        checkin_channel_id: existingChannels.checkin ?? null,
      };

      vi.mocked(supabase.from).mockImplementation(((table: string) => {
        let rowData: any = {
          id: "int-1",
          organization_id: ORG_ID,
          provider: "DISCORD",
          external_id: GUILD,
          enabled: true,
          config: discordConfig,
        };
        if (table === "organizations") {
          rowData = { id: ORG_ID, slug: "test-guild", name: "Test Guild", language: "fr", invite_url: null };
        } else if (table === "organization_integration_secrets") {
          rowData = null;
        }
        const b: any = {
          select: () => b,
          eq: () => b,
          update: () => b,
          maybeSingle: () => Promise.resolve({ data: rowData, error: null }),
          single: () => Promise.resolve({ data: rowData, error: null }),
          then: (resolve: (v: any) => any) => Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return b;
      }) as any);
    }

    it("refuse avec 403 CHANNEL_NOT_ACCESSIBLE si un salon d'organisation modifié est inaccessible", async () => {
      setupOrgDb({ checkin: "111111111111111111" });
      const spy = vi.spyOn(ChannelAccessService, "validateChannelAccess").mockResolvedValueOnce({
        ok: false,
        code: "CHANNEL_NOT_ACCESSIBLE",
        error: "Le salon Discord (chan-private) n'est pas accessible.",
      });

      const out = await callRoute(organizationRouter, {
        method: "PUT",
        path: `/${ORG_ID}/integrations/DISCORD`,
        body: {
          config: {
            checkin_channel_id: "222222222222222222",
          },
        },
        adminCheck: { discordId: "admin-user", guildId: GUILD, access: { level: "SERVER", reason: "ADMINISTRATOR" } },
        locals: { discordClient: fakeClient },
      });

      expect(out.status).toBe(403);
      expect(out.body).toMatchObject({ code: "CHANNEL_NOT_ACCESSIBLE" });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        guildId: GUILD,
        discordId: "admin-user",
        channelIds: ["222222222222222222"],
      }));
    });

    it("ne bloque pas si le salon d'organisation est inchangé", async () => {
      setupOrgDb({ checkin: "123456789012345678" });
      const spy = vi.spyOn(ChannelAccessService, "validateChannelAccess");

      const out = await callRoute(organizationRouter, {
        method: "PUT",
        path: `/${ORG_ID}/integrations/DISCORD`,
        body: {
          config: {
            checkin_channel_id: "123456789012345678",
          },
        },
        adminCheck: { discordId: "admin-user", guildId: GUILD, access: { level: "SERVER", reason: "ADMINISTRATOR" } },
        locals: { discordClient: fakeClient },
      });

      expect(out.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
