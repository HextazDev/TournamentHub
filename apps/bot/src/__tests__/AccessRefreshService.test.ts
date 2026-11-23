import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ invalidateGuildAccess: vi.fn() }));
const registry = vi.hoisted(() => ({ syncGuildAdmins: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../services/MemberAccessService", () => ({ invalidateGuildAccess: access.invalidateGuildAccess }));
vi.mock("../services/GuildRegistryService", () => ({ GuildRegistryService: { syncGuildAdmins: registry.syncGuildAdmins } }));
vi.mock("../utils/logger", () => ({ logger: log }));
const org = vi.hoisted(() => vi.fn());
vi.mock("../utils/tenant", () => ({ resolveOrganization: org }));

import { refreshGuildAccess, type GuildFetcher } from "../services/AccessRefreshService";

const guild = { id: "g1" };
const client = (fetch: () => Promise<unknown>): GuildFetcher => ({ guilds: { fetch } }) as GuildFetcher;
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  org.mockResolvedValue({ id: "o1", slug: "s1", discordEnabled: true, discordGuildId: "g1" });
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
