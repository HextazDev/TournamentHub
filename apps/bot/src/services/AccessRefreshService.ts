import { logger } from "../utils/logger";
import { GuildRegistryService, type GuildFetcher } from "./GuildRegistryService";
import { invalidateGuildAccess } from "./MemberAccessService";
import {
  resolveOrganization,
  runWithoutRequestTenantCache,
  runWithRequestTenantCache,
} from "../utils/tenant";

export type { GuildFetcher };

/** Délai minimal entre deux `guild.members.fetch()` réussis sur le même serveur (DISC-17 / #106). */
const MIN_REFRESH_INTERVAL_MS = 5_000;
/** Marge ajoutée au `retry_after` renvoyé par Discord pour éviter de retomber sur le même bucket. */
const RETRY_SAFETY_MARGIN_MS = 150;
/** Plafond de sécurité sur le délai de rejeu (évite un timer aberrant). */
const MAX_RETRY_DELAY_MS = 60_000;
/** Nombre maximal de rejeux consécutifs sur `GatewayRateLimitError`. */
const MAX_RATE_LIMIT_RETRIES = 3;

const RETRY_AFTER_MESSAGE_RE = /Retry after (\d+(?:\.\d+)?) seconds?/i;

interface GuildRefreshState {
  inFlight: boolean;
  pending: boolean;
  client: GuildFetcher;
  tenantId: string;
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  cooldownUntil: number;
}

const refreshStates = new Map<string, GuildRefreshState>();

/**
 * Extrait le délai d'attente (ms) d'une `GatewayRateLimitError` Discord (opcode 8), ou `null` pour toute autre erreur.
 */
export function extractGatewayRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; message?: unknown; data?: unknown };
  const data =
    candidate.data && typeof candidate.data === "object"
      ? (candidate.data as { opcode?: unknown; retry_after?: unknown })
      : null;

  const isGatewayRateLimit =
    candidate.name === "GatewayRateLimitError" ||
    (data !== null && data.opcode === 8 && typeof data.retry_after === "number");
  if (!isGatewayRateLimit) return null;

  let seconds: number | null = null;
  if (data && typeof data.retry_after === "number" && Number.isFinite(data.retry_after) && data.retry_after >= 0) {
    seconds = data.retry_after;
  } else if (typeof candidate.message === "string") {
    const match = RETRY_AFTER_MESSAGE_RE.exec(candidate.message);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed >= 0) seconds = parsed;
    }
  }
  if (seconds === null) return null;

  const delayMs = Math.ceil(seconds * 1_000) + RETRY_SAFETY_MARGIN_MS;
  return Math.min(delayMs, MAX_RETRY_DELAY_MS);
}

/**
 * Annule tout rejeu planifié pour un serveur (départ du bot ou désactivation de l'intégration Discord).
 * Par défaut, préserve un cooldown encore actif afin de ne pas violer la fenêtre gateway en cas de réactivation immédiate ;
 * `forgetCooldown: true` supprime intégralement l'état (ex. `guildDelete`).
 */
export function cancelGuildAccessRefresh(guildId: string, options?: { forgetCooldown?: boolean }): void {
  const state = refreshStates.get(guildId);
  if (!state) return;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.pending = false;
  state.retryCount = 0;
  if (options?.forgetCooldown || (!state.inFlight && state.cooldownUntil <= Date.now())) {
    refreshStates.delete(guildId);
  }
}

/** Annule les timers et réinitialise les files par serveur (utilisé dans les tests). */
export function resetAccessRefreshState(): void {
  for (const state of refreshStates.values()) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
  refreshStates.clear();
}

function pruneExpiredStates(now: number): void {
  for (const [id, s] of refreshStates) {
    if (!s.inFlight && !s.pending && s.timer === null && s.cooldownUntil <= now) {
      refreshStates.delete(id);
    }
  }
}

function scheduleGuildSync(guildId: string, state: GuildRefreshState, delayMs: number): void {
  if (state.timer !== null) return;
  const timer = setTimeout(() => {
    if (refreshStates.get(guildId) !== state) return;
    state.timer = null;
    void runGuildSync(guildId, state);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function runGuildSync(guildId: string, state: GuildRefreshState): Promise<void> {
  if (refreshStates.get(guildId) !== state) return;
  if (state.inFlight) {
    state.pending = true;
    return;
  }

  state.inFlight = true;
  state.pending = false;

  try {
    const guild = await state.client.guilds.fetch(guildId);
    if (refreshStates.get(guildId) !== state) return;
    // PERF-01 / DISC-17 : cache de requête tout neuf et éphémère pour cette exécution (jamais hérité d'une route HTTP).
    const synced = await runWithRequestTenantCache(() => GuildRegistryService.syncGuildAdmins(guild));
    if (refreshStates.get(guildId) !== state) return;
    if (!synced) logger.warn(`[AccessRefresh] Annuaire des accès Discord non resynchronisé pour ${guildId}.`);
    state.retryCount = 0;
    state.cooldownUntil = Date.now() + MIN_REFRESH_INTERVAL_MS;
  } catch (error: unknown) {
    if (refreshStates.get(guildId) !== state) return;
    const retryAfterMs = extractGatewayRetryAfterMs(error);
    if (retryAfterMs !== null) {
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + retryAfterMs);
    }
    if (retryAfterMs !== null && state.retryCount < MAX_RATE_LIMIT_RETRIES) {
      state.retryCount += 1;
      state.pending = false;
      logger.warn(
        `[AccessRefresh] Limitation de débit gateway Discord sur ${guildId} (tentative ${state.retryCount}/${MAX_RATE_LIMIT_RETRIES}), rejeu dans ${retryAfterMs} ms.`,
      );
      scheduleGuildSync(guildId, state, retryAfterMs);
    } else {
      state.retryCount = 0;
      logger.error(`[AccessRefresh] Resynchronisation des accès de ${state.tenantId} (${guildId}) échouée:`, error);
    }
  } finally {
    if (refreshStates.get(guildId) === state) {
      state.inFlight = false;
      if (state.timer === null && state.pending) {
        state.pending = false;
        const waitMs = Math.max(0, state.cooldownUntil - Date.now());
        if (waitMs > 0) {
          scheduleGuildSync(guildId, state, waitMs);
        } else {
          void runGuildSync(guildId, state);
        }
      }
    }
  }
}

async function enqueueDirectoryResync(client: GuildFetcher, tenantId: string): Promise<void> {
  pruneExpiredStates(Date.now());
  const org = await resolveOrganization(tenantId);
  if (!org) return;
  // Une même décision est mise en cache sous chaque identifiant de l'organisation (UUID, slug, serveur).
  invalidateGuildAccess(org.id);
  invalidateGuildAccess(org.slug);
  if (org.discordGuildId) invalidateGuildAccess(org.discordGuildId);
  // Organisation sans Discord actif : aucun annuaire à reconstruire.
  if (!org.discordEnabled || !org.discordGuildId) return;

  const guildId = org.discordGuildId;
  let state = refreshStates.get(guildId);
  if (!state) {
    state = {
      inFlight: false,
      pending: false,
      client,
      tenantId,
      timer: null,
      retryCount: 0,
      cooldownUntil: 0,
    };
    refreshStates.set(guildId, state);
  } else {
    state.client = client;
    state.tenantId = tenantId;
  }

  if (state.inFlight) {
    state.pending = true;
    return;
  }
  if (state.timer !== null) {
    return;
  }

  const waitMs = Math.max(0, state.cooldownUntil - Date.now());
  if (waitMs > 0) {
    scheduleGuildSync(guildId, state, waitMs);
    return;
  }

  await runGuildSync(guildId, state);
}

/**
 * Un changement modifie qui accède au panel (rôle TO d'un tournoi, archivage, création avec rôle TO).
 * SEC-05 : le cache d'accès est invalidé immédiatement (synchrone) ; DISC-08 / DISC-17 : l'annuaire
 * `integration_access_grants` est resynchronisé en arrière-plan, hors du cache `AsyncLocalStorage` HTTP,
 * regroupé par serveur (une seule synchro en vol, fenêtre minimale entre deux appels réussis) avec rejeu
 * borné sur `GatewayRateLimitError`. Toute erreur est journalisée ; aucune promesse ne reste non gérée.
 */
export function refreshGuildAccess(client: GuildFetcher, guildId: string): void {
  invalidateGuildAccess(guildId);
  runWithoutRequestTenantCache(() => {
    enqueueDirectoryResync(client, guildId).catch((error: unknown) => {
      logger.error(`[AccessRefresh] Resynchronisation des accès de ${guildId} échouée:`, error);
    });
  });
}

