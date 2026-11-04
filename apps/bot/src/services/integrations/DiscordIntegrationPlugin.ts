import type { Client } from "discord.js";
import type { IntegrationEventContext, IntegrationPlugin } from "../IntegrationBus";
import { RegistrationService } from "../RegistrationService";
import { LifecycleService } from "../LifecycleService";
import { ArchiveService } from "../ArchiveService";
import { supabase } from "../../lib/supabase";

/**
 * Plugin d'intégration Discord officiel (RFC 0001 Q3 / Q4).
 * N'est exécuté par IntegrationBus que lorsque l'intégration DISCORD de l'organisation est active (`enabled = true`).
 */
export const discordIntegrationPlugin: IntegrationPlugin = {
  provider: "DISCORD",

  async onRegistrationOpened(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId || !ctx.discordClient) return;
    await RegistrationService.sendRegistrationEmbed(ctx.tournamentId, ctx.discordClient as Client);
  },

  async onTournamentLaunched(ctx: IntegrationEventContext): Promise<void> {
    const guildId = ctx.guildId ?? ctx.integration.external_id;
    if (!ctx.tournamentId || !guildId || !ctx.discordClient) return;
    await LifecycleService.launchTournament(ctx.tournamentId, guildId, ctx.discordClient as Client);
  },

  async onPhaseSynced(ctx: IntegrationEventContext): Promise<void> {
    const guildId = ctx.guildId ?? ctx.integration.external_id;
    if (!ctx.phaseId || !guildId || !ctx.discordClient) return;
    await LifecycleService.syncPhaseChannels(ctx.phaseId, guildId, ctx.discordClient as Client);
  },

  async onTournamentCompleted(ctx: IntegrationEventContext): Promise<void> {
    const guildId = ctx.guildId ?? ctx.integration.external_id;
    if (!ctx.tournamentId || !guildId || !ctx.discordClient) return;
    await LifecycleService.closeTournament(ctx.tournamentId, guildId, ctx.discordClient as Client);
  },

  async cleanupExternalResources(ctx: IntegrationEventContext): Promise<void> {
    const guildId = ctx.guildId ?? ctx.integration.external_id;
    if (!guildId || !ctx.discordClient) return;
    const { data: activeTournaments } = await supabase
      .from("tournaments")
      .select("id, discord_captain_role_id, discord_checkin_channel_id")
      .eq("organization_id", ctx.organizationId)
      .neq("status", "ARCHIVED");
    if (activeTournaments && activeTournaments.length > 0) {
      await ArchiveService.backgroundDiscordCleanup(
        ctx.discordClient as Client,
        guildId,
        activeTournaments as {
          id: string;
          discord_captain_role_id: string | null;
          discord_checkin_channel_id: string | null;
        }[],
      );
    }
  },
};
