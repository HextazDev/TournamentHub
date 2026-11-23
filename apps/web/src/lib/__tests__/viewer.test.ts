import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({ current: null as { accessToken?: string; user?: { id?: string } } | null }));

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => sessionState.current),
}));
vi.mock("../../app/api/auth/[...nextauth]/route", () => ({ authOptions: {} }));
vi.mock("../supabase-admin", () => ({ supabaseAdmin: {} }));

describe("getViewer (#102 point 6) : cache des serveurs Discord et repli sur 429", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("renvoie guildsError=true sur un 429 Discord sans cache préalable (déclenche le bandeau servers.discordUnavailable)", async () => {
    sessionState.current = { accessToken: "tok-1", user: { id: "user-429-cold" } };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });

    const { getViewer } = await import("../viewer");
    const viewer = await getViewer();

    expect(viewer).toEqual({ discordId: "user-429-cold", guilds: null, guildsError: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("met en cache 60 s les serveurs puis replie sur la dernière liste connue en cas de 429 après expiration", async () => {
    const guilds = [{ id: "111111111111111111", name: "Splat FR", icon: null, owner: true, permissions: "8" }];
    sessionState.current = { accessToken: "tok-2", user: { id: "user-429-warm" } };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => guilds });

    const { getViewer } = await import("../viewer");

    // 1. Premier appel : interroge Discord et peuple le cache
    const first = await getViewer();
    expect(first).toEqual({ discordId: "user-429-warm", guilds, guildsError: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2. Appel dans la fenêtre TTL (30 s) : servi depuis le cache sans nouvel appel Discord
    vi.advanceTimersByTime(30_000);
    const cached = await getViewer();
    expect(cached).toEqual({ discordId: "user-429-warm", guilds, guildsError: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 3. Après expiration (61 s) + Discord 429 : replie sur la dernière liste connue sans priver l'utilisateur de ses droits
    vi.advanceTimersByTime(31_000);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    const staleFallback = await getViewer();
    expect(staleFallback).toEqual({ discordId: "user-429-warm", guilds, guildsError: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
