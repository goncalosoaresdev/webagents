# Webcode

Webcode is a self-hosted browser workspace for coding agents. The application runs on a VPS and
drives provider CLIs installed and authenticated on that machine.

The repository is a clean-room implementation. It borrows architectural lessons—not source code—from
projects such as T3 Code: structured provider protocols, adapters at the runtime boundary, dynamic
model discovery, deterministic process ownership, and provider-neutral UI events.

## Implemented

- Responsive, Codex-inspired browser workspace
- Project source picker for existing VPS folders, HTTPS/SSH Git URLs, and GitHub repositories
- Provider and model picker interaction
- Provider-neutral TypeScript contracts
- Codex App Server JSON-RPC client with bounded messages, requests, and diagnostics
- Codex authentication and model discovery adapter
- Muse Code adapter via the official `@muse-code/sdk` (Muse Spark)
- Grok Build adapter over Agent Client Protocol (`grok agent stdio`)
- Fastify HTTP and WebSocket service with security headers, origin enforcement, and rate limits
- Versioned API and single-use WebSocket tickets
- Provider registry with caching, concurrent-request deduplication, hard timeouts, and isolated failures
- Structured, secret-redacted logs and graceful process shutdown
- Unit and HTTP contract tests

## Development

```bash
npm install
npm run dev
```

The web UI is available at `http://localhost:3000` by default.

Create a local server configuration:

```bash
cp .env.example .env
```

Then start the API:

```bash
npm run dev:server
```

The default API address is `http://127.0.0.1:8787`. Loopback development can run without authentication. Production and non-loopback listeners require
`WEBCODE_AUTH_TOKEN` with at least 32 random characters. The browser prompts for this token and keeps
it only in memory; use HTTPS for remote access. Set `WEBCODE_ALLOWED_ORIGINS` to your exact frontend origin.

## API

| Endpoint                             | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `GET /healthz`                       | Process liveness                              |
| `GET /readyz`                        | Service readiness and registered provider IDs |
| `GET /api/v1/providers`              | Cached live provider/account/model snapshots  |
| `POST /api/v1/providers/:id/refresh` | Force a provider refresh                      |
| `GET /api/v1/projects/directories`   | Browse directories accessible to the server user |
| `POST /api/v1/projects`              | Register an existing workspace directory      |
| `POST /api/v1/projects/clone`        | Clone a Git or GitHub repository               |
| `POST /api/v1/auth/websocket-ticket` | Mint a 30-second, single-use realtime ticket  |
| `GET /ws?ticket=...`                 | Provider snapshot stream and refresh commands |

Existing folders can be registered anywhere the server user can access. `WEBCODE_WORKSPACE_ROOT`
sets the default browsing location and destination for cloned repositories; it does not require
moving existing projects. Execution revalidates the registered canonical directory.

## Reliability

Tasks, turns, approvals, and paginated event history persist in SQLite. The browser retries interrupted
reads and retains unconfirmed send IDs in tab session storage. Shutdown waits for turn finalization;
a restart marks unfinished work failed without automatically replaying commands. Existing databases
migrate in place. Back up the data directory and Codex home before upgrading; stop the backend for a
consistent filesystem copy, or use SQLite's online backup API while running.

This backend supports one user and one backend process. Deploy it under an unprivileged service
account with a supervisor, TLS routing, and resource limits. The UI is a Vite React app; the API is
the Fastify process. Vite's proxy is for development; production routing must explicitly forward API
and WebSocket requests to the VPS backend. The frontend cannot itself spawn provider processes.

## Verification

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build:all
```

The provider backend requires Node.js 22.13 or newer on the VPS. Run it as a dedicated, unprivileged
Unix user, keep the default loopback bind, and authenticate Codex as that same Unix user. Use a TLS reverse proxy to route `/api` and `/ws` to the backend and other paths to the frontend.
`npm run start:server` enforces production mode and requires the token. Never expose `codex app-server`
or `muse serve` directly to the internet. Authenticate Muse as the same Unix user that runs the backend
(`muse login` or `META_API_KEY`).

See [Provider architecture](docs/provider-architecture.md) for the adapter boundary and invariants.
