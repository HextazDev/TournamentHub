import { describe, expect, it } from "vitest";
import { readBotEnvironment } from "../config/environment";
import { createHealthRouter } from "../routes/HealthRouter";
import { callRoute } from "./helpers/route";

const configured = {
  NODE_ENV: "production", DISCORD_TOKEN: "test-discord-token",
  DISCORD_CLIENT_ID: "123456789012345678", SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key", BOT_API_SECRET: "a".repeat(48),
};

describe("deployment configuration", () => {
  it("OPS-01: rejects absent production configuration without revealing values", () => {
    expect(() => readBotEnvironment({ NODE_ENV: "production" })).toThrow("DISCORD_TOKEN");
    expect(() => readBotEnvironment({ ...configured, PORT: "private-value" })).toThrow("PORT");
    try { readBotEnvironment({ ...configured, PORT: "private-value" }); }
    catch (error) { expect(String(error)).not.toContain("private-value"); }
  });
  it("OPS-01: malformed URLs never escape validation or reveal supplied values", () => {
    for (const url of ["", "private-invalid-url"]) {
      expect(() => readBotEnvironment({ ...configured, SUPABASE_URL: url })).toThrow("Invalid bot environment: SUPABASE_URL");
      try { readBotEnvironment({ ...configured, SUPABASE_URL: url }); }
      catch (error) { expect(String(error)).not.toContain("private-invalid-url"); }
    }
  });
  it("OPS-01: rejects unsafe production defaults and malformed URLs", () => {
    expect(() => readBotEnvironment({ ...configured, BOT_API_SECRET: "dev-bot-secret-key-123" })).toThrow("BOT_API_SECRET");
    expect(() => readBotEnvironment({ ...configured, SUPABASE_SERVICE_ROLE_KEY: "dummy_key_for_testing" })).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(() => readBotEnvironment({ ...configured, SUPABASE_URL: "ftp://example.com" })).toThrow("SUPABASE_URL");
    expect(() => readBotEnvironment({ ...configured, PORT: "65536" })).toThrow("PORT");
  });
  it("OPS-01: accepts explicit production configuration and preserves development defaults", () => {
    expect(readBotEnvironment(configured).PORT).toBe(8080);
    expect(readBotEnvironment({ NODE_ENV: "test" }).SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });
});

describe("health endpoints", () => {
  it("OPS-02: liveness remains compatible while disconnected", async () => {
    const router = createHealthRouter(() => false, async () => true);
    expect(await callRoute(router, { method: "GET", path: "/health" })).toEqual({
      status: 200, body: { status: "ok", botConnected: false },
    });
    expect((await callRoute(router, { method: "GET", path: "/ready" })).status).toBe(503);
  });
  it("OPS-02: readiness requires current Gateway and database availability", async () => {
    for (const available of [true, false]) {
      const router = createHealthRouter(() => true, async () => available);
      expect((await callRoute(router, { method: "GET", path: "/ready" })).status).toBe(available ? 200 : 503);
    }
    const router = createHealthRouter(() => true, async () => { throw new Error("secret database diagnostic"); });
    expect(await callRoute(router, { method: "GET", path: "/ready" })).toEqual({
      status: 503, body: { status: "unavailable" },
    });
  });
});
