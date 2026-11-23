import type { Client } from "discord.js";
import type { IntegrationEventContext, IntegrationPlugin } from "../IntegrationBus";
import { RegistrationService } from "../RegistrationService";
import { LifecycleService } from "../LifecycleService";
import { supabase } from "../../lib/supabase";

/** Client et serveur requis par un effet Discord ; une intégration active sans eux est une anomalie à remonter au TO. */
function requireDiscord(ctx: IntegrationEventContext): { client: Client; guildId: string } {
  const guildId = ctx.guildId ?? ctx.integration.external_id;
  if (!ctx.discordClient || !guildId) throw new Error("Intégration Discord active sans client ou sans serveur lié");
  return { client: ctx.discordClient, guildId };
}

/**
 * Plugin d'intégration Discord officiel (RFC 0001 Q3 / Q4).
 * N'est exécuté par IntegrationBus qu'après le commit métier, lorsque l'intégration DISCORD est active.
 */
export const discordIntegrationPlugin: IntegrationPlugin = {
  provider: "DISCORD",

  async onRegistrationOpened(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId) return;
    const { client, guildId } = requireDiscord(ctx);
    await RegistrationService.publishRegistrationEmbed(ctx.tournamentId, client, guildId);
  },

  async onTournamentLaunched(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId) return;
    const { client, guildId } = requireDiscord(ctx);
    await LifecycleService.syncDiscordLaunch(ctx.tournamentId, guildId, client);
  },

  async onPhaseSynced(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.phaseId) return;
    const { client, guildId } = requireDiscord(ctx);
    await LifecycleService.syncPhaseChannels(ctx.phaseId, guildId, client);
  },

  async onTournamentCompleted(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId) return;
    const { client, guildId } = requireDiscord(ctx);
    await LifecycleService.deleteDiscordCategory(ctx.tournamentId, guildId, client);
  },

  /** Case « Supprimer la catégorie et les salons du tournoi en cours » à la désactivation (RFC, décision 2). */
  async cleanupExternalResources(ctx: IntegrationEventContext): Promise<void> {
    const { client, guildId } = requireDiscord(ctx);
    const { data, error } = await supabase
      .from("tournaments")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "ACTIVE");
    if (error) throw error;
    for (const tournament of (data ?? []) as { id: string }[]) {
      await LifecycleService.deleteDiscordCategory(tournament.id, guildId, client);
    }
  },
};
