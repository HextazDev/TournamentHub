import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ invalidateGuildAccess: vi.fn() }));
const registry = vi.hoisted(() => ({ syncGuildAdmins: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../services/MemberAccessService", () => ({ invalidateGuildAccess: access.invalidateGuildAccess }));
vi.mock("../services/GuildRegistryService", () => ({ GuildRegistryService: { syncGuildAdmins: registry.syncGuildAdmins } }));
vi.mock("../utils/logger", () => ({ logger: log }));
const org = vi.hoisted(() => vi.fn());
vi.mock("../utils/tenant", () => ({ resolveOrganization: org }));

import { refreshGuildAccess, resetAccessRefreshState, type GuildFetcher } from "../services/AccessRefreshService";

const guild = { id: "g1" };
const client = (fetch: (guildId: string) => Promise<unknown>): GuildFetcher => ({ guilds: { fetch } }) as GuildFetcher;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeGatewayRateLimitError(retryAfterSeconds: number, includeData = true): Error & { data?: { opcode: number; retry_after: number } } {
  const err = new Error(`Request with opcode 8 was rate limited. Retry after ${retryAfterSeconds} seconds.`) as Error & {
    data?: { opcode: number; retry_after: number };
  };
  err.name = "GatewayRateLimitError";
  if (includeData) {
    err.data = { opcode: 8, retry_after: retryAfterSeconds };
  }
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccessRefreshState();
  org.mockResolvedValue({ id: "o1", slug: "s1", discordEnabled: true, discordGuildId: "g1" });
});

afterEach(() => {
  resetAccessRefreshState();
  vi.useRealTimers();
});

describe("refreshGuildAccess (SEC-05 / DISC-08)", () => {
  it("invalide le cache tout de suite, puis resynchronise guild_admins en arrière-plan", async () => {
    registry.syncGuildAdmins.mockResolvedValue(true);
    const result = refreshGuildAccess(client(() => Promise.resolve(guild)), "g1");
    expect(result).toBeUndefined();
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("g1");
    await flush();
    expect(registry.syncGuildAdmins).toHaveBeenCalledWith(guild);
  });

  it("organisation Web : invalide tous ses identifiants sans jamais appeler Discord", async () => {
    org.mockResolvedValue({ id: "o1", slug: "s1", discordEnabled: false, discordGuildId: null });
    const fetch = vi.fn();
    refreshGuildAccess(client(fetch), "s1");
    await flush();
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("o1");
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("s1");
    expect(fetch).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("ne bloque jamais l'appelant : une synchro qui ne se résout pas ne retient rien", () => {
    registry.syncGuildAdmins.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    refreshGuildAccess(client(() => new Promise(() => undefined)), "g1");
    expect(Date.now() - started).toBeLessThan(50);
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("g1");
  });

  it("journalise l'erreur complète (serveur introuvable, synchro en échec) sans promesse non gérée", async () => {
    const boom = new Error("Unknown Guild");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      refreshGuildAccess(client(() => Promise.reject(boom)), "g1");
      await flush();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("g1"), boom);

      const syncError = new Error("members fetch failed");
      registry.syncGuildAdmins.mockRejectedValue(syncError);
      refreshGuildAccess(client(() => Promise.resolve(guild)), "g1");
      await flush();
      await flush();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("g1"), syncError);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("refreshGuildAccess — regroupement et rejeu sur GatewayRateLimitError (DISC-17 / #106)", () => {
  it("DISC-17: deux appels concurrents sur le même serveur n'exécutent qu'une synchro en vol puis replanifient une seule relance", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (ok: boolean) => void;
    registry.syncGuildAdmins
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(true);

    const fetch = vi.fn(() => Promise.resolve(guild));
    refreshGuildAccess(client(fetch), "o1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    // Deux appels supplémentaires pendant que le premier est encore en vol (par slug et guildId)
    refreshGuildAccess(client(fetch), "s1");
    refreshGuildAccess(client(fetch), "g1");
    await vi.advanceTimersByTimeAsync(0);
    // Toujours une seule synchro en vol ; l'invalidation du cache reste immédiate
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("s1");
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith("g1");

    // Le premier termine -> la relance coalescée est replanifiée après le cooldown
    resolveFirst(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_500);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(2);
  });

  it("DISC-17: deux appels rapprochés consécutifs (rattachement puis sauvegarde) retardent le second au-delà du cooldown", async () => {
    vi.useFakeTimers();
    registry.syncGuildAdmins.mockResolvedValue(true);
    const fetch = vi.fn(() => Promise.resolve(guild));

    refreshGuildAccess(client(fetch), "o1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    // 2 secondes plus tard, enregistrement des paramètres (rôle TO)
    await vi.advanceTimersByTimeAsync(2_000);
    refreshGuildAccess(client(fetch), "o1");
    await vi.advanceTimersByTimeAsync(0);
    // Pas d'appel immédiat à la gateway
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    // Une fois le cooldown écoulé, la seconde synchro s'exécute automatiquement
    await vi.advanceTimersByTimeAsync(3_500);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(2);
  });

  it("DISC-17: rejoue après le délai retry_after sur GatewayRateLimitError et réussit au rejeu", async () => {
    vi.useFakeTimers();
    registry.syncGuildAdmins
      .mockRejectedValueOnce(makeGatewayRateLimitError(4.098))
      .mockResolvedValueOnce(true);

    const fetch = vi.fn(() => Promise.resolve(guild));
    refreshGuildAccess(client(fetch), "o1");
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("g1"));

    // Avant les 4.098s -> pas encore rejoué
    await vi.advanceTimersByTimeAsync(4_000);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    // Après retry_after + marge -> rejoué et réussi
    await vi.advanceTimersByTimeAsync(500);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("DISC-17: extrait retry_after depuis le message si data.retry_after est absent", async () => {
    vi.useFakeTimers();
    registry.syncGuildAdmins
      .mockRejectedValueOnce(makeGatewayRateLimitError(2.5, false))
      .mockResolvedValueOnce(true);

    refreshGuildAccess(client(() => Promise.resolve(guild)), "o1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_400);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("DISC-17: abandonne et journalise en erreur après épuisement des tentatives de rate limit", async () => {
    vi.useFakeTimers();
    const rateErr = makeGatewayRateLimitError(1);
    registry.syncGuildAdmins.mockRejectedValue(rateErr);

    refreshGuildAccess(client(() => Promise.resolve(guild)), "o1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(1);

    // 3 rejeux au plafond -> total 4 appels (1 initial + 3 retries), puis arrêt
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(4);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("g1"), rateErr);
  });

  it("DISC-17: traite deux serveurs distincts indépendamment sans blocage croisé", async () => {
    vi.useFakeTimers();
    org.mockImplementation((id: string) =>
      Promise.resolve(
        id === "o2"
          ? { id: "o2", slug: "s2", discordEnabled: true, discordGuildId: "g2" }
          : { id: "o1", slug: "s1", discordEnabled: true, discordGuildId: "g1" },
      ),
    );
    registry.syncGuildAdmins
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(true);

    const fetch = vi.fn((gid: string) => Promise.resolve({ id: gid }));
    refreshGuildAccess(client(fetch), "o1");
    refreshGuildAccess(client(fetch), "o2");
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.syncGuildAdmins).toHaveBeenCalledTimes(2);
    expect(registry.syncGuildAdmins).toHaveBeenNthCalledWith(1, { id: "g1" });
    expect(registry.syncGuildAdmins).toHaveBeenNthCalledWith(2, { id: "g2" });
  });
});

