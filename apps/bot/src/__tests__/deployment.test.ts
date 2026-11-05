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
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key", BOT_API_SECRET: "a".repeat(48), INTEGRATION_ENCRYPTION_KEY: "c".repeat(64),
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

  function createFakeBins(opts: {
    readySucceedsForImage: string;
    initialRunningImage: string;
    targetPulledImage: string;
    upExitCodeForTarget?: number;
    initialRunningWebImage?: string;
    targetPulledWebImage?: string;
    actualStartedWebImage?: string;
    botRevisionLabel?: string;
    webRevisionLabel?: string;
  }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rollout-test-"));
    const stateFile = path.join(tmpDir, "running-image.txt");
    const webStateFile = path.join(tmpDir, "running-web-image.txt");
    const targetBotFile = path.join(tmpDir, "target-bot-image.txt");
    const logFile = path.join(tmpDir, "commands.log");
    const rejectedStateFile = path.join(tmpDir, "rejected.state");
    fs.writeFileSync(stateFile, opts.initialRunningImage, "utf8");
    fs.writeFileSync(webStateFile, opts.initialRunningWebImage ?? "sha256:old-web-111", "utf8");
    fs.writeFileSync(targetBotFile, opts.targetPulledImage, "utf8");
    fs.writeFileSync(logFile, "", "utf8");

    const upExitCode = opts.upExitCodeForTarget ?? 0;
    const targetWeb = opts.targetPulledWebImage ?? "sha256:new-web-222";
    const startedWeb = opts.actualStartedWebImage ?? targetWeb;
    const botRev = opts.botRevisionLabel ?? "commit-same";
    const webRev = opts.webRevisionLabel ?? "commit-same";

    const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
echo "docker $* (BOT_IMAGE=\${BOT_IMAGE:-} WEB_IMAGE=\${WEB_IMAGE:-})" >> "${logFile}"
if [[ "\${1:-}" == "compose" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "ps" ]]; then
      last_arg="\${!#}"
      if [[ "$last_arg" == "web" ]]; then
        echo "container-web-1"
      else
        echo "container-bot-1"
      fi
      exit 0
    fi
    if [[ "$arg" == "up" ]]; then
      if [[ "\${BOT_IMAGE:-}" == sha256:* ]]; then
        echo -n "\${BOT_IMAGE}" > "${stateFile}"
        if [[ -n "\${WEB_IMAGE:-}" ]]; then
          echo -n "\${WEB_IMAGE}" > "${webStateFile}"
        fi
        exit 0
      else
        cat "${targetBotFile}" | tr -d '\\n' > "${stateFile}"
        echo -n "${startedWeb}" > "${webStateFile}"
        exit ${upExitCode}
      fi
    fi
  done
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  cid="\${!#}"
  if [[ "$cid" == "container-web-1" ]]; then
    cat "${webStateFile}"
  else
    cat "${stateFile}"
  fi
  echo ""
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  img="\${!#}"
  if [[ "$*" == *"org.opencontainers.image.revision"* ]]; then
    if [[ "$img" == *web* ]]; then
      echo "${webRev}"
    else
      echo "${botRev}"
    fi
    exit 0
  fi
  if [[ "$img" == *web* ]]; then
    echo "${targetWeb}"
  else
    cat "${targetBotFile}"
  fi
  exit 0
fi
exit 0
`;
    const fakeCurl = `#!/usr/bin/env bash
current="$(cat "${stateFile}")"
if [[ "${opts.readySucceedsForImage}" == *"$current"* ]]; then
  exit 0
fi
exit 22
`;
    fs.writeFileSync(path.join(tmpDir, "docker"), fakeDocker, { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "curl"), fakeCurl, { mode: 0o755 });
    return { tmpDir, stateFile, webStateFile, targetBotFile, logFile, rejectedStateFile };
  }

  it("pulls target image, verifies digest and succeeds when /ready returns 200", () => {
    const { tmpDir, stateFile, logFile, rejectedStateFile } = createFakeBins({
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
          REJECTED_STATE_FILE: rejectedStateFile,
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
    const { tmpDir, stateFile, logFile, rejectedStateFile } = createFakeBins({
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
            REJECTED_STATE_FILE: rejectedStateFile,
            READY_TIMEOUT_SECONDS: "2",
            POLL_INTERVAL_SECONDS: "1",
          },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-digest-111");
      expect(fs.readFileSync(logFile, "utf8")).toContain("BOT_IMAGE=sha256:old-digest-111");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches docker compose up failure (exit 42) under set -e, rolls back and verifies restored readiness", () => {
    const { tmpDir, stateFile, logFile, rejectedStateFile } = createFakeBins({
      initialRunningImage: "sha256:old-digest-111",
      targetPulledImage: "sha256:broken-up-42",
      readySucceedsForImage: "sha256:old-digest-111",
      upExitCodeForTarget: 42,
    });
    try {
      let stderrOutput = "";
      try {
        execFileSync("bash", [rolloutScript], {
          env: {
            ...process.env,
            PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
            BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:sha-broken",
            REJECTED_STATE_FILE: rejectedStateFile,
            READY_TIMEOUT_SECONDS: "2",
            POLL_INTERVAL_SECONDS: "1",
          },
          stdio: "pipe",
        });
        expect.unreachable("rollout.sh should have exited non-zero after rollback");
      } catch (err: unknown) {
        stderrOutput = String((err as { stderr?: Buffer }).stderr ?? "");
      }
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-digest-111");
      expect(fs.readFileSync(logFile, "utf8")).toContain("BOT_IMAGE=sha256:old-digest-111");
      expect(stderrOutput).toContain("Rolled back and verified ready on previous image digest");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("verifies web image digest in DEPLOY_PROFILE=full and rolls back both bot and web on mismatch", () => {
    const { tmpDir, stateFile, webStateFile, logFile, rejectedStateFile } = createFakeBins({
      initialRunningImage: "sha256:old-bot-111",
      targetPulledImage: "sha256:new-bot-222",
      readySucceedsForImage: "sha256:new-bot-111,sha256:old-bot-111",
      initialRunningWebImage: "sha256:old-web-111",
      targetPulledWebImage: "sha256:new-web-222",
      actualStartedWebImage: "sha256:wrong-web-999",
    });
    try {
      expect(() =>
        execFileSync("bash", [rolloutScript], {
          env: {
            ...process.env,
            PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
            DEPLOY_PROFILE: "full",
            BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:sha-new",
            WEB_IMAGE: "ghcr.io/hextazdev/tournamenthub-web:sha-new",
            REJECTED_STATE_FILE: rejectedStateFile,
            READY_TIMEOUT_SECONDS: "2",
            POLL_INTERVAL_SECONDS: "1",
          },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-bot-111");
      expect(fs.readFileSync(webStateFile, "utf8")).toBe("sha256:old-web-111");
      expect(fs.readFileSync(logFile, "utf8")).toContain(
        "BOT_IMAGE=sha256:old-bot-111 WEB_IMAGE=sha256:old-web-111",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("quarantines a rejected digest after rollback so timer runs do not retry it until a new digest is published", () => {
    const { tmpDir, stateFile, targetBotFile, logFile, rejectedStateFile } = createFakeBins({
      initialRunningImage: "sha256:old-digest-111",
      targetPulledImage: "sha256:broken-digest-999",
      readySucceedsForImage: "sha256:old-digest-111,sha256:fixed-digest-333",
    });
    const baseEnv = {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
      BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:staging",
      REJECTED_STATE_FILE: rejectedStateFile,
      SKIP_IF_UNCHANGED: "1",
      READY_TIMEOUT_SECONDS: "2",
      POLL_INTERVAL_SECONDS: "1",
    };
    try {
      // 1st timer run: broken-digest-999 fails readiness and rolls back to old-digest-111
      expect(() => execFileSync("bash", [rolloutScript], { env: baseEnv, stdio: "pipe" })).toThrow();
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-digest-111");
      expect(fs.existsSync(rejectedStateFile)).toBe(true);

      // Clear log and run 2nd timer tick with the same broken :staging digest: must skip without calling `up -d`!
      fs.writeFileSync(logFile, "", "utf8");
      const secondOut = execFileSync("bash", [rolloutScript], { env: baseEnv, encoding: "utf8" });
      expect(secondOut).toContain("previously rejected");
      expect(fs.readFileSync(logFile, "utf8")).not.toContain("up -d");
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-digest-111");

      // 3rd timer tick: a new healthy digest (sha256:fixed-digest-333) is published to :staging -> deploys and clears quarantine
      fs.writeFileSync(targetBotFile, "sha256:fixed-digest-333", "utf8");
      execFileSync("bash", [rolloutScript], { env: baseEnv, stdio: "pipe" });
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:fixed-digest-333");
      expect(fs.existsSync(rejectedStateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses full-stack rollout before touching running containers when bot and web images belong to different commits", () => {
    const { tmpDir, stateFile, webStateFile, logFile } = createFakeBins({
      initialRunningImage: "sha256:old-bot-111",
      targetPulledImage: "sha256:new-bot-222",
      readySucceedsForImage: "sha256:new-bot-222,sha256:old-bot-111",
      initialRunningWebImage: "sha256:old-web-111",
      targetPulledWebImage: "sha256:new-web-222",
      botRevisionLabel: "commit-aaa111",
      webRevisionLabel: "commit-bbb222",
    });
    try {
      expect(() =>
        execFileSync("bash", [rolloutScript], {
          env: {
            ...process.env,
            PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
            DEPLOY_PROFILE: "full",
            BOT_IMAGE: "ghcr.io/hextazdev/tournamenthub-bot:staging",
            WEB_IMAGE: "ghcr.io/hextazdev/tournamenthub-web:staging",
            READY_TIMEOUT_SECONDS: "2",
            POLL_INTERVAL_SECONDS: "1",
          },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(fs.readFileSync(logFile, "utf8")).not.toContain("up -d");
      expect(fs.readFileSync(stateFile, "utf8")).toBe("sha256:old-bot-111");
      expect(fs.readFileSync(webStateFile, "utf8")).toBe("sha256:old-web-111");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
