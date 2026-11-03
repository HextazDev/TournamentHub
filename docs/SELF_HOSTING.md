# Bot/API Docker installation

This guide packages the **Discord bot and Express API**, which share one process.
It supports an existing Next.js frontend on Vercel or another Node.js host. It does
not move the official frontend, change Discord settings, migrate an existing
database, or deploy anything automatically. The same application features and
access checks serve official and community instances. No TournamentHub subscription
is required; infrastructure and external service quotas remain the operator's responsibility.

## Architecture and current limits

`browser -> Next.js/NextAuth -> authenticated Express API -> Discord + Supabase`.
The browser uses Supabase's public Data API/Realtime subject to RLS; it never gets
the bot API secret or service-role key. Next.js injects the API bearer token and
the user's Discord identity on server-side proxy calls. Keep those checks intact.

This change covers bot/API packaging, environment validation, health and operations.
The development `docker-compose.yml` remains available. **Do not use its watchers,
host networking or code mounts for production.** The old web Dockerfile is not a
validated production installation. Full web+bot Compose, web public build-variable
handling, versioned public images, automatic webhook provisioning and real homelab
acceptance remain tracked by [#54](https://github.com/HextazDev/TournamentHub/issues/54).
This PR must not close that issue.

## Prerequisites and database

Use a Linux host/VM with Docker Engine and Compose v2, outgoing HTTPS to Discord
and Supabase and Discord Gateway WebSocket access. No inbound Discord port is needed.
For Proxmox, use a dedicated VM; Docker in LXC has not been validated here. Resource
requirements must be measured on a test instance, not inferred from this guide.

Supply a **separate Supabase project for each instance**. A PostgreSQL URL alone
is insufficient: TournamentHub needs the Data API, `anon`/`service_role` keys, RPC,
RLS and Realtime. For managed Supabase, create your project and apply the versioned
migrations using Supabase CLI migration tracking. For self-hosted Supabase, operate
the complete [official Supabase stack](https://supabase.com/docs/guides/self-hosting/docker)
separately, with its own TLS, secrets, volumes and backups. This repository does
not provision or claim to have tested that production stack. `supabase start`
is a development stack, not this production service's database.

On a **new test database first**, use the CLI pinned by your operations tooling:

```sh
# Managed project: confirm the selected project before any write.
supabase link --project-ref YOUR_TEST_PROJECT_REF
supabase db push --linked --dry-run
supabase db push --linked
# For a separately operated Supabase database, use the equivalent --db-url flow
# and its migration history. Keep credentials out of shell history and logs.
```

Before upgrading: back up the database, record the migration history and application
commit, inspect the dry-run, apply only pending migrations, then deploy the compatible
application version. Never use `make db-init` or `db reset` on an existing production
database. Never blindly mark migrations as applied. On failure, stop and inspect
migration history before retrying; restore to a new database if recovery is needed.

## Discord and private runtime configuration

Create your own Discord application. Enable **Server Members Intent**, plus the
Guilds and GuildMessages intents used by the code. Invite with `bot` and
`applications.commands` scopes. Grant View Channels, Send Messages, Embed Links,
Read Message History, Manage Channels, Manage Roles and Manage Nicknames as needed by tournament
features. Place the bot role above roles it manages; Administrator is unnecessary.
Use the same application ID for the web OAuth provider and this bot.

```sh
cp deploy/bot.env.example deploy/bot.env
chmod 600 deploy/bot.env
```

Edit the private file; Git and Docker build context exclude it. For credentials
under arbitrary names, keep them **outside the checkout/build context**. Use a
secret manager to materialize this file when available. Docker administrators can
inspect runtime environment variables; this is not an encrypted secret store.
Never paste `docker inspect`, rendered Compose config or raw logs into an issue.

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

Generate `BOT_API_SECRET` with a cryptographic generator, for example
`openssl rand -hex 32`. Do not reuse the development example. Production startup
rejects missing variables and known placeholder credentials, without printing their
values. This validates configuration format, not credential validity or schema version.

## Build and start (operator action only)

Run these commands yourself **only on the intended test host** after configuration:

```sh
docker compose -p tournamenthub-staging -f compose.production.yml config --quiet
docker compose -p tournamenthub-staging -f compose.production.yml build bot
docker compose -p tournamenthub-staging -f compose.production.yml up -d bot
docker compose -p tournamenthub-staging -f compose.production.yml ps
curl --fail http://127.0.0.1:8080/ready
```

The image builds the shared package before the bot with `npm ci` on Node 22 and
installs only bot/shared production dependencies in the final image. It runs as
`node`, directly starts Node (no PM2), and contains compiled application artifacts.
Compose adds an init process, a read-only filesystem, temporary `/tmp`, no code
mounts, no extra capabilities and a normal bridge network. Dependencies need no
local application data volumes; all durable application state is in Supabase.

Slash command registration is **never automatic**. After checking the application
ID and credentials, an operator can deliberately register commands using the final
image, without ts-node or development dependencies:

```sh
docker compose -p tournamenthub-staging -f compose.production.yml run --rm \
  -e DISCORD_COMMAND_SCOPE=guild bot node dist/deploy-commands.js
# For your production application, explicitly use DISCORD_COMMAND_SCOPE=global.
```

This replaces the command list for that application/scope. It is a Discord write;
do not run it against the official application during development. Native development
can continue using the existing `npm run deploy-commands --workspace=@hub/bot` script.

## Vercel frontend and HTTPS proxy

Keep existing Vercel deployments and settings unchanged when reviewing this PR.
For a new instance, configure the web's existing `.env.example` variables on its
server: Supabase public URL/anon key, server-only service-role key, `BOT_API_SECRET`,
Discord client ID/secret, `NEXTAUTH_SECRET` and the exact HTTPS `NEXTAUTH_URL`.
Register `https://YOUR_WEB_HOST/api/auth/callback/discord` in Discord.

The current web uses `NEXT_PUBLIC_BOT_API_URL` **on its server** for proxy calls.
Set it to your externally reachable API HTTPS origin when running on Vercel;
Vercel cannot reach the Docker bridge name or your host's localhost. This value is
public and must never embed a credential. `NEXT_PUBLIC_*` settings are frozen into
the Next.js build: rebuild/redeploy your own frontend when changing public settings.
Do not promote an image built for one Supabase instance to another unchanged.

The API port binds to `127.0.0.1` by default. Place an HTTPS reverse proxy on the
host, forwarding to `127.0.0.1:8080`, for example:

```caddyfile
api.your-community.example {
    reverse_proxy 127.0.0.1:8080
}
```

For a containerized proxy, attach it to the Compose network and route to `bot:8080`,
or configure an explicit private host bind. Avoid exposing unencrypted port 8080
publicly. Preserve Host and forwarded protocol for web OAuth/cookies on any web
proxy. API bearer/admin checks remain required behind TLS. Allow the necessary
server-side Vercel and Supabase webhook callers through any additional access
gateway. Cloudflare Tunnel is optional, never a dependency. A self-hosted Supabase
proxy must also support Realtime WebSocket upgrades for browser subscribers.
Tailscale on the VM alone does not make the API reachable from Vercel. Interactive
Cloudflare Access blocks server-to-server calls unless an appropriate noninteractive
authentication mechanism is configured; the current web proxy sends no Access
credentials. If cloudflared runs in a container, its localhost is not the bot:
attach it to the Compose network and target `bot:8080` instead.

### Optional teams webhook

Check-ins made through the bot (Discord check-in button, back-office check-in
toggle) apply the captain role and team nickname directly: no webhook is needed
for them. The Supabase `teams` database webhook is **optional** and only
resynchronizes changes made outside the bot (direct database edits).

If you provision it, `POST /api/webhook/team-update` requires **both**
`Authorization: Bearer <BOT_API_SECRET>` (API middleware) and
`x-webhook-secret: <WEBHOOK_SECRET or BOT_API_SECRET>` (webhook handler).
Set these as private headers in a Supabase `teams` database webhook, pointing
to your HTTPS API endpoint, using the Supabase webhook payload. Do not put the
secret in a query string even though the legacy handler accepts one. Malformed
payloads are rejected without touching Discord. A failed Discord update returns
a failure response, but may leave a partial change (the role is still attempted
when the nickname is refused); retries are handled by the webhook operator.
See `apps/bot/TROUBLESHOOTING.md` for the `[CaptainPresence]` log reasons.

## Staging, production, logs and health

Use distinct Compose project names, private env files, host ports, Discord
applications, test guilds and Supabase projects. `NODE_ENV=staging` is inappropriate:
use `production` for both. For example, export `BOT_ENV_FILE=/private/staging.env`
and `BOT_HOST_PORT=8081`, then use `-p tournamenthub-staging`. Production might use
`/private/production.env`, port 8080 and `-p tournamenthub-production`. A project
name alone does not isolate Discord or database credentials. Do not run two active
bot instances against the same application/database: schedulers can duplicate work.

`/health` retains HTTP 200 liveness with `botConnected` reflecting `client.isReady()`.
`/ready` returns 200 only after scheduler restoration, with a current Gateway connection and a successful minimal
Supabase read, otherwise 503; its database timeout is 3 seconds. Neither endpoint
returns credentials or database error details. Restrict public access to probes
at the proxy if desired. This probe does not prove every RPC or the entire schema.
Scheduler restoration retries every 30 seconds after an initial failure; this does not
guarantee that every scheduled Discord operation succeeds. Express currently starts after Discord login, so probes may be unreachable during
startup. The image allows a 90-second start period.

Winston emits JSON in production: info to stdout, warnings/errors to stderr.
No log files are written inside the container. Compose's `json-file` driver rotates
at **10 MiB, 3 files per container**. Inspect privately with `docker compose ... logs
--tail=100 bot`. Redact tokens, request headers, personal data and database diagnostics
before sharing. Existing error paths are not a universal automatic redaction system.
`restart: unless-stopped` restarts after crashes/host reboot (Docker service must
start on boot). An unhealthy Docker health status **does not automatically restart**
a live container; alert and diagnose rather than restart-looping on a database outage.
Existing SIGTERM/SIGINT handlers cancel scheduled jobs and destroy Discord; shutdown
does not guarantee completion of already running application work.

## Upgrade, rollback and backup

Record the exact source commit and locally built image ID/digest for each version;
do not rely on a mutable `latest` tag. Keep the previous image and env configuration.
Take database backups and test migration changes in staging before building/updating
production. Recreate the service deliberately with the compatible new image. Rolling
back the application is safe only if its schema is still compatible; otherwise
restore a verified backup onto a **new** Supabase instance and test before cutover.
No automatic migration or database reset runs at container startup.

Back up data, schema, database roles/migration history, Supabase configuration,
private instance configuration and any Supabase Storage objects used by your
installation. A SQL dump alone does not back up object storage or deployment secrets.
Encrypt backups, restrict access and retention, and use the managed provider's
restore procedure or your self-hosted Supabase backup/restore tooling. A restoration
exercise must restore onto a fresh independent Supabase stack, apply pending
migrations only, configure a fresh test Discord application and verify OAuth,
permissions, tournaments, roles and Realtime before being considered successful.

## Verification evidence and remaining acceptance

Audit on 2026-11-01 found five production dependency advisories in the previous
lockfile (one critical, three high, one moderate), including Next.js 16.4.0.
The bot's unused direct Next.js dependency has since been removed; the web still
uses Next.js, and a fresh audit of the final image remains necessary.
Dependency remediation and a fresh audit are required before production approval;
this packaging change does not upgrade those dependencies or certify the instance
as secure. Linux CI for commit e3fda45 passed both the monorepo build and Docker
image checks; a separate Windows local build encountered a Next.js route typing
failure. Recheck CI for subsequent commits.

The PR adds local Vitest tests for rejected configuration, sanitized diagnostics,
disconnected Gateway, successful readiness and database failure. The dedicated CI
workflow builds the final bot image, checks the non-root user/runtime dependencies,
tests missing-config failure with networking disabled and validates Compose. It
never logs in to Discord, starts a production service, publishes an image or deploys.

On a disposable test VM, still verify: build/start from this guide; missing-config
failure; health transitions during Gateway/database outages; crash/reboot recovery;
SIGTERM; command registration; OAuth behind HTTPS; cross-guild access refusals;
registration/score, teams webhook role synchronization and browser Realtime; upgrade
and restoration to a fresh instance. Record the commit, image digest, tool versions,
results and measured VM resources without secrets. These real-service/homelab tests
are not proven by unit tests or a successful Docker build and require a separate
authorized operational session. Do not migrate or cut over the official instance
as part of this PR.
