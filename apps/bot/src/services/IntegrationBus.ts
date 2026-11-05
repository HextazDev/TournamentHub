import type { IntegrationProvider, IntegrationWarning, OrganizationIntegration } from "@hub/shared";
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

/** INT-01 : délai maximal d'attente d'un plugin ; au-delà, la requête repart sans lui et le TO est averti. */
export const INTEGRATION_TIMEOUT_MS = 5_000;
/** Création de salons en série (rate-limit Discord) : seule exception au délai standard. */
const SLOW_EVENT_TIMEOUT_MS = 30_000;
const SLOW_EVENTS: ReadonlySet<IntegrationEventName> = new Set(["onTournamentLaunched", "onPhaseSynced", "onTournamentCompleted"]);

class IntegrationTimeoutError extends Error {}

/** Le handler n'est pas annulable : il continue en arrière-plan et sa fin tardive est seulement journalisée. */
async function runWithTimeout(work: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IntegrationTimeoutError(`${label} : délai de ${timeoutMs} ms dépassé`)), timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } catch (err) {
    if (err instanceof IntegrationTimeoutError) {
      work.catch((late: unknown) => logger.error(`[IntegrationBus] Échec tardif de ${label}:`, late));
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

  /**
   * Exécute les plugins actifs, isolés les uns des autres, après le commit métier de l'appelant.
   * Ne lève jamais : les échecs passent l'intégration en `DEGRADED` et sont renvoyés comme avertissements.
   */
  static async emit(
    event: IntegrationEventName,
    payload: EmitIntegrationPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<IntegrationWarning[]> {
    if (!payload.organizationId) return [];

    const { data, error } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("organization_id", payload.organizationId)
      .eq("enabled", true);

    if (error) {
      logger.error(`[IntegrationBus] Lecture des intégrations impossible pour ${payload.organizationId}:`, error);
      return [];
    }

    const timeoutMs = options.timeoutMs ?? (SLOW_EVENTS.has(event) ? SLOW_EVENT_TIMEOUT_MS : INTEGRATION_TIMEOUT_MS);
    const results = await Promise.all(
      ((data ?? []) as OrganizationIntegration[]).map((integration) =>
        this.runPlugin(event, payload, integration, timeoutMs),
      ),
    );
    return results.filter((warning): warning is IntegrationWarning => warning !== null);
  }

  private static async runPlugin(
    event: IntegrationEventName,
    payload: EmitIntegrationPayload,
    integration: OrganizationIntegration,
    timeoutMs: number,
  ): Promise<IntegrationWarning | null> {
    const provider = integration.provider;
    const plugin = plugins.get(provider);
    const handler = plugin?.[event];
    if (!plugin || typeof handler !== "function") return null;

    const ctx: IntegrationEventContext = {
      ...payload,
      guildId: payload.guildId ?? integration.external_id,
      integration,
    };

    try {
      await runWithTimeout(handler.call(plugin, ctx), timeoutMs, `${provider}.${event}`);
      if (integration.status === "DEGRADED") {
        await this.recordHealth(integration.id, { status: "CONNECTED", last_error: null, last_sync_at: new Date().toISOString() });
      }
      return null;
    } catch (err: unknown) {
      logger.error(`[IntegrationBus] Échec du plugin ${provider} sur ${event} (org=${payload.organizationId}):`, err);
      await this.recordHealth(integration.id, {
        status: "DEGRADED",
        last_error: err instanceof Error ? err.message : String(err),
      });
      return { provider, code: err instanceof IntegrationTimeoutError ? "INTEGRATION_TIMEOUT" : "INTEGRATION_FAILED" };
    }
  }

  /** L'état de santé est informatif : son échec d'écriture est journalisé sans affecter la mutation métier. */
  private static async recordHealth(integrationId: string, health: Record<string, string | null>): Promise<void> {
    const { error } = await supabase
      .from("organization_integrations")
      .update({ ...health, updated_at: new Date().toISOString() })
      .eq("id", integrationId);
    if (error) logger.error(`[IntegrationBus] Écriture de l'état de santé impossible pour ${integrationId}:`, error);
  }
}
