# Docker Self-Hosting Guide (`bot` + `web`)

This guide covers production packaging and operations for **TournamentHub** in two supported modes:
1. **Bot/API only** (`bot` service in Docker Compose + Next.js frontend hosted on Vercel or another Node.js host).
2. **Full self-hosted stack** (`bot` + `web` services in Docker Compose via `--profile full`).

It does not move the official instance, alter Discord applications automatically, migrate an existing database on startup, or deploy anything without operator action. The same application features and multi-tenant access checks serve official and community instances. No TournamentHub subscription is required; infrastructure and external service quotas remain the operator's responsibility.

## Architecture and security boundaries

`browser -> Next.js/NextAuth -> authenticated Express API -> Discord + Supabase`.
The browser uses Supabase's public Data API and Realtime subject to RLS (`SEC-07`, `SEC-10`); it never receives `BOT_API_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`. Next.js injects the API bearer token (`BOT_API_SECRET`) and the user's Discord identity (`X-Discord-User-Id`) on server-side proxy calls (`SEC-06`, `SEC-13`).

In `compose.production.yml`, the `web` container reaches the bot over the internal Docker bridge network via `BOT_API_URL=http://bot:8080`, while browsers only talk to Next.js (`/api/bot/...`). Public Supabase settings (`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`) are injected at request time by `RootLayout` (`window.__HUB_PUBLIC_CONFIG__`) as well as supported at build time, so **pre-built GHCR images work at runtime without per-instance rebuilds and without embedding secrets in the client bundle**.

The development `docker-compose.yml` remains available for local development. **Never use its watchers, host networking or source mounts in production.**

## Prerequisites and database

Use a Linux host/VM with Docker Engine and Compose v2, outgoing HTTPS to Discord and Supabase, and Discord Gateway WebSocket access. No inbound Discord port is needed. For Proxmox, use a dedicated VM; Docker in LXC has not been validated here. Resource requirements must be measured on a test instance, not inferred from this guide.

Supply a **separate Supabase project for each instance**. A PostgreSQL URL alone is insufficient: TournamentHub needs the Data API, `anon`/`service_role` keys, RPC, RLS and Realtime. For managed Supabase, create your project and apply the versioned migrations using Supabase CLI migration tracking. For self-hosted Supabase, operate the complete [official Supabase stack](https://supabase.com/docs/guides/self-hosting/docker) separately, with its own TLS, secrets, volumes and backups. `supabase start` is a development stack, not a production database.

On a **new test database first**, use the CLI pinned by your operations tooling:

```sh
# Managed project: confirm the selected project before any write.
supabase link --project-ref YOUR_TEST_PROJECT_REF
supabase db push --linked --dry-run
supabase db push --linked
# For a separately operated Supabase database, use the equivalent --db-url flow
# and its migration history. Keep credentials out of shell history and logs.
```

Before upgrading: back up the database, record the migration history and application commit, inspect the dry-run, apply only pending migrations, then deploy the compatible application version. Never use `make db-init` or `db reset` on an existing production database. Never blindly mark migrations as applied. On failure, stop and inspect migration history before retrying; restore to a new database if recovery is needed.

## Discord and private runtime configuration

Create your own Discord application. Enable **Server Members Intent**, plus the Guilds and GuildMessages intents used by the code. Invite with `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles and Manage Nicknames as needed by tournament features. Place the bot role above roles it manages; Administrator is unnecessary. Use the same application ID for the web OAuth provider and this bot, and register `https://YOUR_WEB_HOST/api/auth/callback/discord` in Discord OAuth2 Redirects.

```sh
cp deploy/bot.env.example deploy/bot.env
cp deploy/web.env.example deploy/web.env
chmod 600 deploy/bot.env deploy/web.env
```

Edit the private files; Git and the Docker build context exclude `*.env`. Never paste `docker inspect`, rendered Compose config or raw logs into an issue.

### Bot environment (`deploy/bot.env`)

| Variable | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Private bot token from your Discord application; required |
| `DISCORD_CLIENT_ID` | Numeric application ID; required in production |
| `SUPABASE_URL` | Supabase HTTP(S) Data API base URL reachable from the container; required |
| `SUPABASE_SERVICE_ROLE_KEY` | Private key from that same Supabase instance; required |
| `BOT_API_SECRET` | Random shared server-to-server secret, at least 32 characters in production; required |
| `FRONTEND_URL` | Optional exact web origin for CORS; absent means no browser CORS access |
| `WEBHOOK_SECRET` | Optional additional webhook credential; defaults to `BOT_API_SECRET` |
| `DISCORD_GUILD_ID` | Test guild for explicit guild command registration |
| `DISCORD_COMMAND_SCOPE` | `global` (default) or `guild`, only used by the container command registration entrypoint |
| `PORT` | Native runtime HTTP port (1–65535, default 8080); Compose fixes container port to 8080 |
| `NODE_ENV` | Compose/image sets `production`; staging must also use production runtime behavior |

### Web environment (`deploy/web.env`, required for `--profile full` or standalone web)

| Variable | Meaning |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public HTTPS URL of your Supabase Data API / Realtime; required |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public `anon` key of your Supabase project (enforced by RLS); required |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only `service_role` key from the same Supabase project; required |
| `BOT_API_URL` | Internal server-to-server URL to the bot API (`http://bot:8080` in full Compose); required |
| `BOT_API_SECRET` | Same random secret (>= 32 chars) as `deploy/bot.env`; required |
| `NEXTAUTH_URL` | Canonical public HTTPS URL of the web app (`https://tournoi.example.org`); required |
| `NEXTAUTH_SECRET` | Random secret (>= 32 chars) signing NextAuth session cookies; required |
| `DISCORD_CLIENT_ID` | Numeric Discord application ID; required |
| `DISCORD_CLIENT_SECRET` | Private Discord OAuth2 client secret; required |

Generate `BOT_API_SECRET` and `NEXTAUTH_SECRET` with a cryptographic generator, e.g. `openssl rand -hex 32`. Both `bot` and `web` containers validate their environment before opening their listening port and fail closed if variables are missing or contain development placeholders, without printing secret values (`OPS-01`, `OPS-06`).

## Build and start (operator action only)

Run these commands yourself **only on the intended test host** after configuration.

### Mode A — Bot/API only (with external / Vercel frontend)

```sh
docker compose -p tournamenthub-staging -f compose.production.yml config --quiet
docker compose -p tournamenthub-staging -f compose.production.yml build bot
docker compose -p tournamenthub-staging -f compose.production.yml up -d bot
docker compose -p tournamenthub-staging -f compose.production.yml ps
curl --fail http://127.0.0.1:8080/ready
```

### Mode B — Full self-hosted stack (`bot` + `web`)

```sh
docker compose -p tournamenthub-staging --profile full -f compose.production.yml config --quiet
docker compose -p tournamenthub-staging --profile full -f compose.production.yml build
docker compose -p tournamenthub-staging --profile full -f compose.production.yml up -d
docker compose -p tournamenthub-staging --profile full -f compose.production.yml ps
curl --fail http://127.0.0.1:8080/ready
curl --fail http://127.0.0.1:3000/api/health
```

### Using published GHCR images instead of building locally

GitHub Actions (`docker-bot.yml`) builds, verifies and publishes versioned images (`ghcr.io/<owner>/tournamenthub-bot` and `ghcr.io/<owner>/tournamenthub-web`) tagged by commit (`sha-<12chars>`) and release tag (`vX.Y.Z`) without embedding instance secrets:

```sh
export BOT_IMAGE=ghcr.io/hextazdev/tournamenthub-bot:sha-XXXXXXXXXXXX
export WEB_IMAGE=ghcr.io/hextazdev/tournamenthub-web:sha-XXXXXXXXXXXX
docker compose -p tournamenthub-staging --profile full -f compose.production.yml pull
docker compose -p tournamenthub-staging --profile full -f compose.production.yml up -d --no-build
```

Both images run on Node 22 as non-root users (`node` for bot, `nextjs` for web), directly start Node (no PM2), and use a read-only root filesystem with `tmpfs` mounts, `cap_drop: ALL`, `no-new-privileges: true` and a bridge network. All durable state lives in Supabase.

### Explicit Slash command registration

Slash command registration is **never automatic** on container start:

```sh
docker compose -p tournamenthub-staging -f compose.production.yml run --rm \
  -e DISCORD_COMMAND_SCOPE=guild bot node dist/deploy-commands.js
# For your production application, explicitly use DISCORD_COMMAND_SCOPE=global.
```

## Reverse proxy HTTPS (Full stack and Vercel modes)

Both `bot` (`127.0.0.1:8080`) and `web` (`127.0.0.1:3000`) bind to loopback by default. Place an HTTPS reverse proxy on the host and preserve `Host`, `X-Forwarded-Proto` and `X-Forwarded-For` headers so NextAuth OAuth callbacks and `__Secure-` cookies work behind TLS:

```caddyfile
tournoi.your-community.example {
    reverse_proxy 127.0.0.1:3000
}

api.your-community.example {
    reverse_proxy 127.0.0.1:8080
}
```

- **Full Compose mode (`--profile full`)**: `web` talks to `bot` internally via `BOT_API_URL=http://bot:8080`. Only expose `api.your-community.example` (or `/api/webhook/team-update`) to your Supabase instance for database webhooks.
- **Vercel frontend mode**: Set `BOT_API_URL` (or `NEXT_PUBLIC_BOT_API_URL`) on Vercel to `https://api.your-community.example`, since Vercel cannot reach the Docker bridge or host loopback.
- **Self-hosted Supabase Realtime**: Ensure your Supabase reverse proxy supports WebSocket `Upgrade: websocket` on `/realtime/v1/websocket` for browser Realtime subscriptions. Cloudflare Tunnel is optional and never required.

### Teams webhook contract (`OPS-05`)

`POST /api/webhook/team-update` requires **both** headers:
- `Authorization: Bearer <BOT_API_SECRET>`
- `x-webhook-secret: <WEBHOOK_SECRET or BOT_API_SECRET>`

Query-string secrets (`?secret=`) are rejected (`401`). Configure these private headers in your Supabase `teams` (`INSERT`, `UPDATE`, `DELETE`) Database Webhook. See [`apps/bot/TROUBLESHOOTING.md`](../apps/bot/TROUBLESHOOTING.md) for the `curl` test recipe.

## Staging, production, logs and health

Use distinct Compose project names, private env files, host ports (`BOT_HOST_PORT`, `WEB_HOST_PORT`), Discord applications, test guilds and Supabase projects. Keep `NODE_ENV=production` in both staging and production. Never run two active bot instances against the same Discord application or database.

- Bot `/health`: HTTP 200 liveness with `botConnected: client.isReady()`.
- Bot `/ready`: HTTP 200 only after scheduler restoration, with an active Gateway connection and a 3-second Supabase read check (`OPS-02`, `OPS-04`); otherwise 503.
- Web `/api/health`: HTTP 200 when server runtime configuration is valid (`OPS-07`); otherwise 503.
- Logs: JSON to stdout/stderr with Compose `json-file` rotation (`10m`, 3 files). Redact secrets and personal data before sharing.

## Upgrade, rollback and backup

Pin the exact commit/digest (`sha-...` or release tag) rather than a mutable `latest` tag. Before upgrading:
1. Back up the database (schema, data, roles, `supabase_migrations.schema_migrations`), Supabase Storage objects and private `deploy/*.env` files.
2. Test pending migrations (`supabase db push --linked --dry-run` then `supabase db push --linked`) and the new image in staging.
3. Update `BOT_IMAGE` / `WEB_IMAGE` (or rebuild from the tagged commit) and run `up -d`.
4. If rolling back the application image, verify schema compatibility first; if a migration was destructive, restore the verified backup onto a **new** independent Supabase instance, apply compatible migrations, and test OAuth, permissions, webhooks and Realtime before cutover.

## Verification evidence and homelab acceptance checklist

Automated CI checks (`ci.yml` and `docker-bot.yml`):
- Build and unit-test `@hub/shared`, `@hub/bot` and `@hub/web` (`OPS-01`..`OPS-07`).
- Build both `apps/bot/Dockerfile` and `apps/web/Dockerfile` `runner` stages without secrets.
- Verify non-root execution (`node` and `nextjs`), absence of `src/` in final images, and fail-fast startup when configuration is missing (`--network none`).
- Validate `compose.production.yml` in both default (bot-only) and `--profile full` (bot + web) modes.

On a disposable Linux / Proxmox test VM, record the commit, image digests, measured VM RAM/CPU/disk, and verify:
- [ ] Start `bot` alone, then `--profile full` (`bot` + `web`), and confirm `/ready` and `/api/health` return `200`.
- [ ] Verify missing-config rejection, container crash/reboot recovery (`restart: unless-stopped`), and `SIGTERM` shutdown.
- [ ] Register slash commands on a test guild (`node dist/deploy-commands.js`).
- [ ] Complete Discord OAuth login behind HTTPS, tournament registration/check-in, score submission, `teams` webhook role/nickname sync, and browser Realtime updates.
- [ ] Test N -> N+1 image upgrade and backup restoration onto a fresh Supabase test project.
