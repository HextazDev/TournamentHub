# TournamentHub

TournamentHub is a community-driven, open-source platform for managing multi-game esports tournaments. It combines a Discord bot and HTTP API with a Next.js website for players, spectators and tournament organizers.

## Project vision and governance

TournamentHub is a personal project maintained by [Hextaz](https://github.com/Hextaz), with community contributions welcome. The lead maintainer makes the final decisions on the official project's direction and merges.

The project aims to offer two ways to use the same software:

| Mode | Who operates it | Functional scope |
| --- | --- | --- |
| Official instance | The lead maintainer | The community platform hosted and maintained by the project |
| Self-hosted instance | Your community | The same TournamentHub features, using your own configuration and Discord application |

Essential TournamentHub features are not intended to be locked behind a subscription. Self-hosting does not require a TournamentHub subscription; hosting, domain names and external services may have their own costs or quotas.

**Production Docker packaging (Bot/API and Full Stack):** see the [Docker self-hosting guide](docs/SELF_HOSTING.md) and `compose.production.yml`, supporting both Bot/API-only mode (with a Vercel frontend) and Full-Stack mode (`--profile full` running `bot` + `web`), private runtime configuration, GHCR versioned images, staging isolation and homelab acceptance checks. The default `docker-compose.yml` file is for local development only; never use `make dev` in production.

## Architecture

- **`apps/bot`**: Node.js, Express and Discord.js. The Discord bot and HTTP API run in the same process.
- **`apps/web`**: Next.js App Router website with the public portal and organizer back-office. It can run as a Node.js application; the existing official setup also uses Vercel.
- **`packages/shared`**: Shared TypeScript types, utilities and Zod schemas.
- **`supabase`**: Supabase configuration, versioned PostgreSQL migrations, RPC functions and row-level security policies.
- **`docs/EDGE_CASES.md`**: Security and reliability invariants, known edge cases and test coverage status.

TournamentHub currently depends on Supabase's APIs and Realtime in addition to PostgreSQL. Supplying a standalone PostgreSQL connection is not sufficient. Production support for external and self-hosted Supabase is part of #54.

A community installation must use its own Discord application, tokens, database and URLs. The target installation is independent of the maintainer's domain, Cloudflare account and personal infrastructure. Cloudflare Tunnel is an optional way to expose an instance, not a project requirement.

## Local development

Use a separate Discord development application and test server. Never connect a local development instance to the production bot or database.

### Prerequisites

- Docker with Docker Compose for the local Supabase stack.
- Node.js 22.12 or a newer version compatible with the lockfile. The current CI uses Node.js 22.
- npm and Make.

Both the bot and web Dockerfiles use Node.js 22, the lockfile (`npm ci`) and non-root production runner stages. Use the native workspace commands below for local development.

### Initialize a new local environment

```sh
npm ci
make supabase-start
make env-init
make db-init
```

These commands install dependencies, start local Supabase, generate local environment files and apply migrations to the local database. `make db-init` is an initial development setup command: it replays migrations and must not be used as an upgrade command on an existing production database.

Complete `apps/bot/.env` and `apps/web/.env.local` using their respective [.env.example](apps/bot/.env.example) and [.env.example](apps/web/.env.example) files:

- Bot: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, optional development `DISCORD_GUILD_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` and `BOT_API_SECRET`.
- Web: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_BOT_API_URL`, `BOT_API_SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

The bot and web need the same service-to-service `BOT_API_SECRET`. Keep it and the Supabase service-role key server-side. Configure the Discord intents required by the bot, including Server Members Intent, and register the web callback URL in the Discord Developer Portal. For the default local web address, the callback is `http://localhost:3000/api/auth/callback/discord`.

### Start the applications

Build the shared package first:

```sh
npm run build --workspace=@hub/shared
```

Then run each application in its own terminal:

```sh
npm run dev:bot
npm run dev:web
```

Register the development bot's slash commands when needed:

```sh
npm run deploy-commands --workspace=@hub/bot
```

Set `DISCORD_GUILD_ID` to the test server and keep `NODE_ENV` out of production mode for guild-scoped registration. Without that development guild configuration, the registration script uses global commands.

## Validation and deployment status

```sh
make test
make lint
make build
```

The current GitHub Actions CI runs unit tests and application builds for pushes and pull requests to `main`. Linting is available through `make lint`; it is not currently a separate CI step.

Both `bot` and `web` have production Dockerfiles, a dedicated `compose.production.yml` (bot-only by default, full stack with `--profile full`), runtime environment validation, healthchecks (`/ready` and `/api/health`) and documented operations in [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). The Docker CI workflow validates both final images without credentials and publishes versioned images (`sha-*` and `v*`) to GHCR on `main` and release tags.

## Contributing

1. Discuss a substantial change in an issue.
2. Create a feature or fix branch and open a pull request to `main`.
3. Keep tests and `docs/EDGE_CASES.md` aligned with behavior changes.
4. Obtain the required review and passing CI, then use squash merge.

For deployment-specific debugging, share only the necessary redacted information. Do not put production credentials, player data or private infrastructure details in issues or pull requests.

## License

TournamentHub is distributed under the **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**. See [LICENSE](LICENSE) for the full terms. Third-party dependencies retain their own licenses and notices.
