import type { Client } from "discord.js";
import { isSyntheticDiscordId } from "@hub/shared";
import type { IntegrationEventContext, IntegrationPlugin } from "../IntegrationBus";
import { RegistrationService } from "../RegistrationService";
import { LifecycleService } from "../LifecycleService";
import { SchedulerService } from "../SchedulerService";
import { ScoreService, type MatchCompletionSource } from "../ScoreService";
import { applyPresence } from "../CaptainPresenceService";
import { supabase } from "../../lib/supabase";

/** Client et serveur requis par un effet Discord ; une intégration active sans eux est une anomalie à remonter au TO. */
function requireDiscord(ctx: IntegrationEventContext): { client: Client; guildId: string } {
  const guildId = ctx.guildId ?? ctx.integration.external_id;
  if (!ctx.discordClient || !guildId) throw new Error("Intégration Discord active sans client ou sans serveur lié");
  return { client: ctx.discordClient, guildId };
}

function readMatchCompletionSource(data: Record<string, unknown> | undefined): MatchCompletionSource | undefined {
  const source = data?.source;
  if (source === "DISCORD" || source === "WEB_CAPTAIN" || source === "WEB_STAFF" || source === "TO_FORCE") {
    return source;
  }
  return undefined;
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

  async onTeamRegistered(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId || !ctx.teamId) return;
    const { client, guildId } = requireDiscord(ctx);
    await RegistrationService.announceTeamRegistration(ctx.tournamentId, ctx.teamId, client, guildId);
  },

  async onCheckinOpened(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId) return;
    const { client, guildId } = requireDiscord(ctx);
    await SchedulerService.publishDiscordCheckinOpen(ctx.tournamentId, guildId, client);
  },

  async onCheckinCompleted(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.teamId) return;
    const { client } = requireDiscord(ctx);
    const { data: team, error } = await supabase
      .from("teams")
      .select("id, tournament_id, name, captain_discord_id")
      .eq("id", ctx.teamId)
      .maybeSingle();
    if (error) throw error;
    if (!team || typeof team.captain_discord_id !== "string" || isSyntheticDiscordId(team.captain_discord_id)) return;
    await applyPresence(client, {
      id: team.id,
      tournament_id: team.tournament_id,
      name: team.name,
      captain_discord_id: team.captain_discord_id,
    });
  },

  async onCheckinClosed(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.tournamentId) return;
    const { client, guildId } = requireDiscord(ctx);
    await SchedulerService.publishDiscordCheckinClose(ctx.tournamentId, guildId, client);
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

  async onMatchCompleted(ctx: IntegrationEventContext): Promise<void> {
    if (!ctx.matchId) return;
    const source = readMatchCompletionSource(ctx.data);
    if (source === "DISCORD") return;
    const { client, guildId } = requireDiscord(ctx);
    const status = typeof ctx.data?.status === "string" ? ctx.data.status : undefined;
    const team1Score = typeof ctx.data?.team1_score === "number" ? ctx.data.team1_score : undefined;
    const team2Score = typeof ctx.data?.team2_score === "number" ? ctx.data.team2_score : undefined;
    await ScoreService.announceMatchCompleted(ctx.matchId, guildId, client, {
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(team1Score !== undefined ? { team1Score } : {}),
      ...(team2Score !== undefined ? { team2Score } : {}),
    });
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
