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
    limit: async () => {
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

    // 3. Accès refusé par le bot ➜ null sans aucune lecture service_role (AUD-SEC-01)
    tournamentOrgId = "org-1";
    const queriesBeforeDenied = queries.length;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hasPermission: false, reason: "NO_RIGHTS" }),
    });
    expect(await getManagedTournament("arena-esports", "t-1")).toBeNull();
    expect(queries.length).toBe(queriesBeforeDenied);
  });

  it("getServerProfile(uuid) résout en 1 requête, retourne null sans fallback si absent et propage les erreurs SQL", async () => {
    const orgUuid = "6bad37e9-b4d1-4451-b6bf-ef13dff9cc31";
    const missingUuid = "00000000-0000-4000-8000-000000000000";
    const queries: RecordedQuery[] = [];
    let simulateError = false;

    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (simulateError) {
          return { data: null, error: { message: "connection lost" } };
        }
        const idFilter = q.filters.find((f) => f.col === "id")?.val;
        if (q.table === "organizations" && idFilter === orgUuid) {
          return {
            data: {
              id: orgUuid,
              slug: "arena-uuid",
              name: "Arena UUID",
              language: "fr",
              organization_integrations: [
                { provider: "TWITCH", external_id: "tw-1", enabled: true },
                { provider: "DISCORD", external_id: "999999999999999999", enabled: false, config: {} },
              ],
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    );

    const { getServerProfile } = await import("../viewer");

    const found = await getServerProfile(orgUuid);
    expect(found).toMatchObject({
      organization_id: orgUuid,
      slug: "arena-uuid",
      discord_enabled: false,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.table).toBe("organizations");

    // UUID introuvable ➜ 1 seule requête (pas de fallback integration ni slug)
    const missing = await getServerProfile(missingUuid);
    expect(missing).toBeNull();
    expect(queries).toHaveLength(2);

    // Erreur Supabase ➜ propagée
    simulateError = true;
    await expect(getServerProfile(orgUuid)).rejects.toThrow("organization read failed: connection lost");
  });

  it("getReadableTournament sur un tournoi privé d'org Web autonome ne fait aucun appel Discord /users/@me/guilds", async () => {
    sessionState.current = { accessToken: "tok-web", user: { id: "u-member" } };
    let isOrgMember = true;
    const queries: RecordedQuery[] = [];

    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (q.table === "tournaments") {
          return { data: { id: "t-priv", name: "Private Cup", organization_id: "org-web", is_public: false }, error: null };
        }
        if (q.table === "organizations") {
          return {
            data: {
              id: "org-web",
              slug: "web-only-org",
              name: "Web Only Org",
              language: "fr",
              organization_integrations: [],
            },
            error: null,
          };
        }
        if (q.table === "organization_members") {
          return { data: isOrgMember ? { role: "MEMBER" } : null, error: null };
        }
        return { data: null, error: null };
      }),
    );

    const { getReadableTournament } = await import("../viewer");

    // 1. Membre de l'org autonome ➜ accès autorisé, 0 appel Discord
    expect(await getReadableTournament("web-only-org", "t-priv")).toMatchObject({ id: "t-priv" });
    expect(fetchMock).not.toHaveBeenCalled();

    // 2. Non-membre de l'org autonome ➜ null (SEC-10), toujours 0 appel Discord
    isOrgMember = false;
    expect(await getReadableTournament("web-only-org", "t-priv")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getReadableTournament sur un tournoi privé avec Discord actif vérifie l'appartenance guilde (SEC-10) et coupe si désactivé (SEC-26)", async () => {
    sessionState.current = { accessToken: "tok-disc", user: { id: "u-disc" } };
    let discordEnabled = true;
    const queries: RecordedQuery[] = [];

    supabaseFromMock.mockImplementation((table: string) =>
      makeQueryChain(table, queries, (q) => {
        if (q.table === "tournaments") {
          return { data: { id: "t-disc", name: "Discord Cup", organization_id: "org-disc", is_public: false }, error: null };
        }
        if (q.table === "organizations") {
          return {
            data: {
              id: "org-disc",
              slug: "discord-org",
              name: "Discord Org",
              language: "fr",
              organization_integrations: [
                {
                  provider: "DISCORD",
                  external_id: "555555555555555555",
                  enabled: discordEnabled,
                  status: discordEnabled ? "CONNECTED" : "DISCONNECTED",
                  config: { bot_present: true },
                },
              ],
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    );

    const { getReadableTournament } = await import("../viewer");

    // 1. Intégration Discord active et utilisateur membre du serveur ➜ autorisé
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: "555555555555555555", name: "Discord Org", icon: null, owner: false, permissions: "0" }],
    });
    expect(await getReadableTournament("discord-org", "t-disc")).toMatchObject({ id: "t-disc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("discord.com/api/users/@me/guilds");

    // 2. SEC-26 : intégration Discord désactivée ➜ l'appartenance serveur ne compte plus et 0 nouvel appel Discord
    discordEnabled = false;
    expect(await getReadableTournament("discord-org", "t-disc")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
