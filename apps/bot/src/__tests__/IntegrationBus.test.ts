import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));

import { encryptSecretPayload, decryptSecretPayload } from "../utils/crypto";
import { IntegrationBus, type IntegrationPlugin } from "../services/IntegrationBus";

const ORG_ID = "00000000-0000-0000-0000-000000000011";

beforeEach(() => {
  vi.clearAllMocks();
  IntegrationBus.clearPlugins();
  db.current = new FakeSupabase({
    organization_integrations: [
      {
        id: "int-discord",
        organization_id: ORG_ID,
        provider: "DISCORD",
        external_id: "g1",
        enabled: true,
        status: "CONNECTED",
        config: {},
      },
      {
        id: "int-twitch",
        organization_id: ORG_ID,
        provider: "TWITCH",
        external_id: "tw1",
        enabled: false,
        status: "DISCONNECTED",
        config: {},
      },
    ],
  });
});

describe("SEC-28: chiffrement AES-256-GCM des secrets d'intégration", () => {
  const secretKey = "a".repeat(64);

  it("chiffre et déchiffre un payload JSON avec IV aléatoire et tag d'authenticité", () => {
    const first = encryptSecretPayload({ apiKey: "sk-test-123" }, secretKey);
    const second = encryptSecretPayload({ apiKey: "sk-test-123" }, secretKey);
    expect(first).not.toEqual(second);
    expect(first).not.toContain("sk-test-123");
    expect(decryptSecretPayload<{ apiKey: string }>(first, secretKey)).toEqual({ apiKey: "sk-test-123" });
  });

  it("rejette un payload altéré (intégrité GCM)", () => {
    const encrypted = encryptSecretPayload({ apiKey: "sk-test-123" }, secretKey);
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:ff${(parts[3] ?? "").slice(2)}`;
    expect(() => decryptSecretPayload(tampered, secretKey)).toThrow();
  });
});

describe("INT-01: IntegrationBus asynchrone et fail-safe", () => {
  it("n'invoque que les plugins dont l'intégration est activée (enabled = true)", async () => {
    const discordHook = vi.fn(async () => undefined);
    const twitchHook = vi.fn(async () => undefined);

    const discordPlugin: IntegrationPlugin = {
      provider: "DISCORD",
      onTournamentLaunched: discordHook,
    };
    const twitchPlugin: IntegrationPlugin = {
      provider: "TWITCH",
      onTournamentLaunched: twitchHook,
    };

    IntegrationBus.registerPlugin(discordPlugin);
    IntegrationBus.registerPlugin(twitchPlugin);

    await IntegrationBus.emit("onTournamentLaunched", {
      organizationId: ORG_ID,
      tournamentId: "t1",
    });

    expect(discordHook).toHaveBeenCalledTimes(1);
    expect(twitchHook).not.toHaveBeenCalled();
  });

  it("INT-01: une panne d'un plugin ne propage jamais d'exception et passe le statut en DEGRADED", async () => {
    const boom = new Error("Discord API 503 Unavailable");
    IntegrationBus.registerPlugin({
      provider: "DISCORD",
      onTournamentLaunched: async () => {
        throw boom;
      },
    });

    await expect(
      IntegrationBus.emit("onTournamentLaunched", {
        organizationId: ORG_ID,
        tournamentId: "t1",
      }),
    ).resolves.toEqual([{ provider: "DISCORD", code: "INTEGRATION_FAILED" }]);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("[IntegrationBus]"), boom);
    const row = db.current?.tables.organization_integrations?.find((r) => r.id === "int-discord");
    expect(row).toMatchObject({
      status: "DEGRADED",
      last_error: "Discord API 503 Unavailable",
    });
  });

  it("INT-01: un plugin qui dépasse le délai ne bloque pas l'appelant et devient un avertissement", async () => {
    IntegrationBus.registerPlugin({
      provider: "DISCORD",
      onRegistrationOpened: () => new Promise<void>(() => undefined),
    });
    const warnings = await IntegrationBus.emit(
      "onRegistrationOpened",
      { organizationId: ORG_ID, tournamentId: "t1" },
      { timeoutMs: 20 },
    );
    expect(warnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_TIMEOUT" }]);
    const row = db.current?.tables.organization_integrations?.find((r) => r.id === "int-discord");
    expect(row?.status).toBe("DEGRADED");
  });

  it("INT-01: une réussite après panne repasse l'intégration en CONNECTED sans avertissement", async () => {
    db.current!.tables.organization_integrations![0]!.status = "DEGRADED";
    IntegrationBus.registerPlugin({ provider: "DISCORD", onRegistrationOpened: async () => undefined });
    const warnings = await IntegrationBus.emit("onRegistrationOpened", { organizationId: ORG_ID, tournamentId: "t1" });
    expect(warnings).toEqual([]);
    const row = db.current?.tables.organization_integrations?.find((r) => r.id === "int-discord");
    expect(row).toMatchObject({ status: "CONNECTED", last_error: null });
  });

  it("CLN-04: un succès tardif après timeout est réconcilié et repasse l'intégration en CONNECTED", async () => {
    let resolveWork: () => void = () => undefined;
    IntegrationBus.registerPlugin({
      provider: "DISCORD",
      onRegistrationOpened: () =>
        new Promise<void>((resolve) => {
          resolveWork = resolve;
        }),
    });

    const warnings = await IntegrationBus.emit(
      "onRegistrationOpened",
      { organizationId: ORG_ID, tournamentId: "t1" },
      { timeoutMs: 10 },
    );
    expect(warnings).toEqual([{ provider: "DISCORD", code: "INTEGRATION_TIMEOUT" }]);
    expect(db.current?.tables.organization_integrations?.find((r) => r.id === "int-discord")?.status).toBe("DEGRADED");

    resolveWork();
    await new Promise((r) => setTimeout(r, 20));

    expect(db.current?.tables.organization_integrations?.find((r) => r.id === "int-discord")).toMatchObject({
      status: "CONNECTED",
      last_error: null,
    });
  });
});
