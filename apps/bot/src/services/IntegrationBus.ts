import type { IntegrationProvider, OrganizationIntegration } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

export interface IntegrationEventContext {
  organizationId: string;
  tournamentId?: string;
  phaseId?: string;
  matchId?: string;
  teamId?: string;
  guildId?: string | null;
  integration: OrganizationIntegration;
  discordClient?: unknown;
  data?: Record<string, unknown>;
}

export type IntegrationEventName =
  | "onTournamentCreated"
  | "onRegistrationOpened"
  | "onTeamRegistered"
  | "onCheckinOpened"
  | "onCheckinCompleted"
  | "onCheckinClosed"
  | "onTournamentLaunched"
  | "onPhaseSynced"
  | "onMatchCompleted"
  | "onTournamentCompleted";

export interface IntegrationPlugin {
  readonly provider: IntegrationProvider;
  onTournamentCreated?(ctx: IntegrationEventContext): Promise<void>;
  onRegistrationOpened?(ctx: IntegrationEventContext): Promise<void>;
  onTeamRegistered?(ctx: IntegrationEventContext): Promise<void>;
  onCheckinOpened?(ctx: IntegrationEventContext): Promise<void>;
  onCheckinCompleted?(ctx: IntegrationEventContext): Promise<void>;
  onCheckinClosed?(ctx: IntegrationEventContext): Promise<void>;
  onTournamentLaunched?(ctx: IntegrationEventContext): Promise<void>;
  onPhaseSynced?(ctx: IntegrationEventContext): Promise<void>;
  onMatchCompleted?(ctx: IntegrationEventContext): Promise<void>;
  onTournamentCompleted?(ctx: IntegrationEventContext): Promise<void>;
  cleanupExternalResources?(ctx: IntegrationEventContext): Promise<void>;
}

export interface EmitIntegrationPayload {
  organizationId: string;
  tournamentId?: string;
  phaseId?: string;
  matchId?: string;
  teamId?: string;
  guildId?: string | null;
  discordClient?: unknown;
  data?: Record<string, unknown>;
}

const plugins = new Map<IntegrationProvider, IntegrationPlugin>();

/**
 * INT-01 (RFC 0001 Q4) : Bus d'intégrations asynchrone et fail-safe.
 * Une panne d'intégration externe (Discord, Twitch, IA) est journalisée et passe l'intégration en `DEGRADED`,
 * sans jamais bloquer ni annuler la mutation métier sur le site Web.
 */
export class IntegrationBus {
  static registerPlugin(plugin: IntegrationPlugin): void {
    plugins.set(plugin.provider, plugin);
  }

  static clearPlugins(): void {
    plugins.clear();
  }

  static getPlugin(provider: IntegrationProvider): IntegrationPlugin | undefined {
    return plugins.get(provider);
  }

  static async emit(event: IntegrationEventName, payload: EmitIntegrationPayload): Promise<void> {
    if (!payload.organizationId) return;

    const { data, error } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("organization_id", payload.organizationId)
      .eq("enabled", true);

    if (error) {
      logger.error(`[IntegrationBus] Lecture des intégrations impossible pour ${payload.organizationId}:`, error);
      return;
    }

    const activeIntegrations = (data ?? []) as OrganizationIntegration[];
    if (activeIntegrations.length === 0) return;

    await Promise.allSettled(
      activeIntegrations.map(async (integration) => {
        const provider = integration.provider ?? integration.type;
        if (!provider) return;
        const plugin = plugins.get(provider);
        const handler = plugin?.[event];
        if (!plugin || typeof handler !== "function") return;

        const ctx: IntegrationEventContext = {
          ...payload,
          guildId: payload.guildId ?? integration.external_id,
          integration,
        };

        try {
          await handler.call(plugin, ctx);
          if (integration.status === "DEGRADED") {
            await supabase
              .from("organization_integrations")
              .update({
                status: "CONNECTED",
                last_error: null,
                last_sync_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", integration.id);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[IntegrationBus] Échec du plugin ${provider} sur ${event} (org=${payload.organizationId}):`, err);
          await supabase
            .from("organization_integrations")
            .update({
              status: "DEGRADED",
              last_error: message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", integration.id);
        }
      }),
    );
  }
}
