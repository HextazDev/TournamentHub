import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({ current: null as { accessToken?: string; user?: { id?: string } } | null }));
const supabaseFromMock = vi.hoisted(() => vi.fn());

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
vi.mock("../supabase-admin", () => ({
  supabaseAdmin: { from: supabaseFromMock },
}));

describe("getViewer (#102 point 6) : cache des serveurs Discord et repli sur 429", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    fetchMock.mockReset();
    supabaseFromMock.mockReset();
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
    const guilds = [{ id: "111111111111111111", name: "Arena FR", icon: null, owner: true, permissions: "8" }];
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

interface RecordedQuery {
  table: string;
  selectCols: string;
  filters: Array<{ col: string; val: unknown }>;
}

function makeQueryChain(
  table: string,
  recorded: RecordedQuery[],
  resolver: (q: RecordedQuery) => { data: unknown; error: null | { message: string; code?: string } },
) {
  const q: RecordedQuery = { table, selectCols: "*", filters: [] };
  const chain = {
    select: (cols: string) => {
      q.selectCols = cols;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      q.filters.push({ col, val });
      return chain;
    },
    maybeSingle: async () => {
      recorded.push(q);
      return resolver(q);
    },
  };
  return chain;
}

describe("viewer (#135) : réduction des waterfalls navigation & résolution 1 requête", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;
  const originalBotSecret = process.env.BOT_API_SECRET;
  const originalBotUrl = process.env.BOT_API_URL;

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    supabaseFromMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.BOT_API_SECRET = "test-secret";
    process.env.BOT_API_URL = "http://bot.internal:8080";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalBotSecret === undefined) delete process.env.BOT_API_SECRET;
    else process.env.BOT_API_SECRET = originalBotSecret;
    if (originalBotUrl === undefined) delete process.env.BOT_API_URL;
    else process.env.BOT_API_URL = originalBotUrl;
  });

  it("getGuildAdminAccess ne fait aucun appel à Discord /users/@me/guilds (lit uniquement la session)", async () => {
    sessionState.current = { accessToken: "tok-admin", user: { id: "u-admin" } };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        hasPermission: true,
        access: { level: "SERVER", reason: "TO_ROLE" },
      }),
    });

    const { getGuildAdminAccess } = await import("../viewer");
    const result = await getGuildAdminAccess("arena-esports");

    expect(result).toEqual({ allowed: true, access: { level: "SERVER", reason: "TO_ROLE" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/discord/permissions");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("discord.com/api/users/@me/guilds");
  });

  it("getServerProfile(slug) résout organisation + intégration Discord en 1 seule requête SQL (sans chercher external_id)", async () => {
    const queries: RecordedQuery[] = [];
    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (q.table === "organizations") {
          return {
            data: {
              id: "org-uuid-1",
              slug: "arena-esports",
              name: "Arena Esports",
              icon_url: null,
              language: "fr",
              public_contact_url: "https://arena.gg",
              updated_at: "2026-11-23T10:00:00Z",
              organization_integrations: [
                {
                  provider: "DISCORD",
                  external_id: "123456789012345678",
                  enabled: true,
                  status: "CONNECTED",
                  last_error: null,
                  config: { bot_present: true, to_role_id: "role-to" },
                },
              ],
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    );

    const { getServerProfile } = await import("../viewer");
    const profile = await getServerProfile("arena-esports");

    expect(profile).toMatchObject({
      organization_id: "org-uuid-1",
      slug: "arena-esports",
      guild_id: "123456789012345678",
      guild_name: "Arena Esports",
      discord_enabled: true,
      to_role_id: "role-to",
      invite_url: "https://arena.gg",
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.table).toBe("organizations");
    expect(queries[0]?.selectCols).toContain("organization_integrations");
  });

  it("getServerProfile(snowflake) résout external_id Discord avant slug (SEC-01) en 1 seule requête SQL jointe", async () => {
    const queries: RecordedQuery[] = [];
    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (q.table === "organization_integrations") {
          return {
            data: {
              provider: "DISCORD",
              external_id: "123456789012345678",
              enabled: true,
              status: "CONNECTED",
              last_error: null,
              config: { bot_present: true },
              organizations: {
                id: "org-uuid-2",
                slug: "real-discord-org",
                name: "Real Discord Org",
                icon_url: null,
                language: "en",
                updated_at: "2026-11-23T10:00:00Z",
              },
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    );

    const { getServerProfile } = await import("../viewer");
    const profile = await getServerProfile("123456789012345678");

    expect(profile).toMatchObject({
      organization_id: "org-uuid-2",
      slug: "real-discord-org",
      guild_id: "123456789012345678",
      language: "en",
      discord_enabled: true,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.table).toBe("organization_integrations");
    expect(queries[0]?.selectCols).toContain("organizations");
  });

  it("getManagedTournament renvoie le tournoi autorisé de la bonne organisation et refuse accès refusé ou autre org (SEC-01)", async () => {
    sessionState.current = { accessToken: "tok-admin", user: { id: "u-admin" } };
    let tournamentOrgId = "org-1";
    const queries: RecordedQuery[] = [];
    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (q.table === "tournaments") {
          return { data: { id: "t-1", name: "Cup", organization_id: tournamentOrgId }, error: null };
        }
        if (q.table === "organizations") {
          return {
            data: {
              id: "org-1",
              slug: "arena-esports",
              name: "Arena Esports",
              language: "fr",
              organization_integrations: [],
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    );

    const { getManagedTournament } = await import("../viewer");

    // 1. Accès autorisé sur org-1 et tournoi dans org-1 ➜ renvoyé
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        hasPermission: true,
        access: { level: "SERVER", reason: "TO_ROLE" },
      }),
    });
    expect(await getManagedTournament("arena-esports", "t-1")).toMatchObject({ id: "t-1", name: "Cup" });

    // 2. Accès autorisé sur org-1 mais tournoi dans org-OTHER ➜ null (SEC-01)
    tournamentOrgId = "org-OTHER";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        hasPermission: true,
        access: { level: "SERVER", reason: "TO_ROLE" },
      }),
    });
    expect(await getManagedTournament("arena-esports", "t-1")).toBeNull();

    // 3. Accès refusé par le bot ➜ null même si le tournoi est dans org-1
    tournamentOrgId = "org-1";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hasPermission: false, reason: "NO_RIGHTS" }),
    });
    expect(await getManagedTournament("arena-esports", "t-1")).toBeNull();
  });
});
