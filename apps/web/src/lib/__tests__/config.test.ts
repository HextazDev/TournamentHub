import { afterEach, describe, expect, it } from "vitest";
import {
  readWebServerEnvironment,
  resolvePublicSupabaseConfig,
  resolveServerBotApiUrl,
  resolveServerSupabaseAdminConfig,
} from "../config";
import { supabaseAdmin } from "../supabase-admin";
import { GET as getHealth } from "../../app/api/health/route";
import { validateWebProductionEnv } from "../../../scripts/start-production.mjs";

const validProdEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real-service-role",
  BOT_API_URL: "http://bot:8080",
  BOT_API_SECRET: "b".repeat(48),
  NEXTAUTH_URL: "https://tournoi.example.org",
  NEXTAUTH_SECRET: "c".repeat(48),
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "real-discord-client-secret-value",
};

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("OPS-06: web server environment validation", () => {
  it("rejects absent production configuration without revealing supplied values", () => {
    expect(() => readWebServerEnvironment({ NODE_ENV: "production" })).toThrow(
      "Invalid web environment:",
    );
    expect(() => validateWebProductionEnv({ NODE_ENV: "production" })).toThrow(
      "Invalid web environment:",
    );
    expect(() => validateWebProductionEnv(validProdEnv)).not.toThrow();
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        NEXTAUTH_URL: "private-malformed-url",
      }),
    ).toThrow("NEXTAUTH_URL");
    try {
      readWebServerEnvironment({
        ...validProdEnv,
        NEXTAUTH_URL: "private-malformed-url",
      });
    } catch (error) {
      expect(String(error)).not.toContain("private-malformed-url");
    }
  });

  it("rejects unsafe development placeholders and short secrets in production", () => {
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
      }),
    ).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        SUPABASE_SERVICE_ROLE_KEY: "ta_cle_service_role_ici",
      }),
    ).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        BOT_API_SECRET: "dev-bot-secret-key-123",
      }),
    ).toThrow("BOT_API_SECRET");
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        NEXTAUTH_SECRET: "un_secret_tres_aleatoire_et_long",
      }),
    ).toThrow("NEXTAUTH_SECRET");
    expect(() =>
      readWebServerEnvironment({
        ...validProdEnv,
        DISCORD_CLIENT_SECRET: "ton_client_secret_ici",
      }),
    ).toThrow("DISCORD_CLIENT_SECRET");
  });

  it("separates internal BOT_API_URL from NEXT_PUBLIC_BOT_API_URL and preserves dev defaults", () => {
    expect(
      resolveServerBotApiUrl({
        ...validProdEnv,
        BOT_API_URL: "http://bot:8080/",
        NEXT_PUBLIC_BOT_API_URL: "https://api.example.org",
      }),
    ).toBe("http://bot:8080");
    expect(
      resolveServerBotApiUrl({
        NODE_ENV: "production",
        NEXT_PUBLIC_BOT_API_URL: "https://api.example.org/",
      }),
    ).toBe("https://api.example.org");
    expect(resolveServerBotApiUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:8080",
    );
  });

  it("resolves public Supabase configuration from runtime injection before build placeholders", () => {
    const resolved = resolvePublicSupabaseConfig(
      {
        NODE_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      {
        supabaseUrl: "https://runtime.supabase.co",
        supabaseAnonKey: "runtime-anon-key",
      },
    );
    expect(resolved).toEqual({
      supabaseUrl: "https://runtime.supabase.co",
      supabaseAnonKey: "runtime-anon-key",
    });
  });

  it("re-resolves supabaseAdmin URL and key at runtime when built with instance A and started with instance B", () => {
    process.env = {
      ...validProdEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://build-instance-a.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-a",
    };
    expect(resolveServerSupabaseAdminConfig(process.env).supabaseUrl).toBe(
      "https://build-instance-a.supabase.co",
    );
    expect((supabaseAdmin as unknown as { supabaseUrl: string }).supabaseUrl).toBe(
      "https://build-instance-a.supabase.co",
    );

    // Runtime container starts against instance B (either via SUPABASE_URL or runtime NEXT_PUBLIC_SUPABASE_URL)
    process.env = {
      ...validProdEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://build-instance-a.supabase.co",
      SUPABASE_URL: "https://runtime-instance-b.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-b",
    };
    expect(resolveServerSupabaseAdminConfig(process.env)).toEqual({
      supabaseUrl: "https://runtime-instance-b.supabase.co",
      supabaseServiceKey: "service-role-key-b",
    });
    expect((supabaseAdmin as unknown as { supabaseUrl: string }).supabaseUrl).toBe(
      "https://runtime-instance-b.supabase.co",
    );
  });
});

describe("OPS-07: web /api/health endpoint", () => {
  it("returns 200 when configuration is valid and 503 without leaking diagnostics when invalid", async () => {
    process.env = { ...validProdEnv };
    const okRes = await getHealth();
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("cache-control")).toBe("no-store");
    expect(await okRes.json()).toEqual({ status: "ok" });

    process.env = {
      ...validProdEnv,
      BOT_API_SECRET: "short-secret-value",
    };
    const failRes = await getHealth();
    expect(failRes.status).toBe(503);
    const body = await failRes.json();
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("short-secret-value");
  });
});
