import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
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

describe("OPS-08: deploy/rollout.sh readiness wait, digest check and automatic rollback", () => {
  const rolloutScript = path.resolve(__dirname, "../../../../deploy/rollout.sh");

  function createFakeBins(opts: { readySucceedsForImage: string; initialRunningImage: string; targetPulledImage: string }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rollout-test-"));
    const stateFile = path.join(tmpDir, "running-image.txt");
    const logFile = path.join(tmpDir, "commands.log");
    fs.writeFileSync(stateFile, opts.initialRunningImage, "utf8");
    fs.writeFileSync(logFile, "", "utf8");

    const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
echo "docker $* (BOT_IMAGE=\${BOT_IMAGE:-})" >> "${logFile}"
if [[ "\${1:-}" == "compose" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "ps" ]]; then
      echo "container-bot-1"
      exit 0
    fi
    if [[ "$arg" == "up" ]]; then
      if [[ "\${BOT_IMAGE:-}" == sha256:* ]]; then
        echo -n "\${BOT_IMAGE}" > "${stateFile}"
      else
        echo -n "${opts.targetPulledImage}" > "${stateFile}"
      fi
      exit 0
    fi
  done
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  cat "${stateFile}"
  echo ""
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  echo "${opts.targetPulledImage}"
  exit 0
fi
exit 0
`;
    const fakeCurl = `#!/usr/bin/env bash
current="$(cat "${stateFile}")"
if [[ "$current" == "${opts.readySucceedsForImage}" ]]; then
  exit 0
fi
exit 22
`;
    fs.writeFileSync(path.join(tmpDir, "docker"), fakeDocker, { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "curl"), fakeCurl, { mode: 0o755 });
    return { tmpDir, stateFile, logFile };
  }

  it("pulls target image, verifies digest and succeeds when /ready returns 200", () => {
    const { tmpDir, stateFile, logFile } = createFakeBins({
      initialRunningImage: "sha256:old-digest-111",
      targetPulledImage: "sha256:new-digest-222",
      readySucceedsForImage: "sha256:new-digest-222",
    });
    try {
      execFileSync("bash", [rolloutScript], {
        env: {
          ...process.env,
          PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
          BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:sha-new",
          READY_TIMEOUT_SECONDS: "4",
          POLL_INTERVAL_SECONDS: "1",
        },
      });
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:new-digest-222");
      expect(fs.readFileSync(logFile, "utf8")).toContain("up -d --no-build");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("automatically rolls back to the previous image digest when /ready fails after update", () => {
    const { tmpDir, stateFile, logFile } = createFakeBins({
      initialRunningImage: "sha256:old-digest-111",
      targetPulledImage: "sha256:broken-digest-999",
      readySucceedsForImage: "sha256:old-digest-111",
    });
    try {
      expect(() =>
        execFileSync("bash", [rolloutScript], {
          env: {
            ...process.env,
            PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
            BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:sha-broken",
            READY_TIMEOUT_SECONDS: "2",
            POLL_INTERVAL_SECONDS: "1",
          },
          stdio: "pipe",
        }),
      ).toThrow();
      // Must have restored the previous working image digest!
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-digest-111");
      expect(fs.readFileSync(logFile, "utf8")).toContain("BOT_IMAGE=sha256:old-digest-111");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
