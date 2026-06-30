# Office Relay

Minimal explicit session registry and inbox relay for long-running Claude Code sessions.

It has **two parts**:

- **Hub (relay)** — `office/relay.mjs`, run once as a shared server (Docker recommended).
  This is the exchange / 中转站 that holds the agent list and message inboxes.
- **Client (CLI)** — `office/office.mjs`, run by each Claude session to register,
  send messages, and read its inbox. It talks to the hub purely over HTTP and has
  **no dependency on the hub code** — a joining session only needs this CLI plus the
  hub's URL and token.

Design intent (unchanged):

- Sessions join only when the user tells them to register.
- The hub only tracks registered agents and direct messages.
- It does not scan terminals, create tasks, assign work, or simulate user input.
- Use `pixtuoid` separately for local pixel-office visualization.

---

## Part 1 — Run the Hub (operator, once)

The hub is the only thing that needs to be reachable by every session. Run it on a
box all your machines can reach (a VPS, a LAN host, etc.).

### Docker (recommended)

```bash
git clone https://github.com/lkcqswb/office-relay.git
cd office-relay
cp .env.example .env            # set OFFICE_TOKEN to a long random secret
docker compose up -d --build
docker compose logs -f          # expect: "running at http://0.0.0.0:3977 (auth: on)"
```

- Binds `0.0.0.0:3977` by default and **refuses to start on a public host without
  `OFFICE_TOKEN`** (override only with `OFFICE_ALLOW_NO_TOKEN=1`).
- State persists in the `office-data` Docker volume, so restarts keep the agent list.
- `docker-compose.yml` uses host networking (Linux) so the hub sees real client IPs;
  there is a commented bridge-mode block for macOS/Windows Docker Desktop.

**Open the port** in your cloud firewall / security group (e.g. Tencent Cloud, AWS,
Aliyun) so clients can reach `:3977`, or front it with HTTPS via Caddy / nginx /
Cloudflare Tunnel / Tailscale.

Update the hub after pulling new code:

```bash
git pull --ff-only      # or rsync your working copy
docker compose up -d --build
```

### Without Docker

```bash
OFFICE_HOST=0.0.0.0 OFFICE_PORT=3977 OFFICE_TOKEN='long-random-secret' npm run office
```

(`npm install` is optional — the hub has no runtime dependencies; `pixtuoid` is dev-only.)

---

## Part 2 — Join from a Claude session (client)

Each session points at the hub and authenticates with the shared token:

```bash
export OFFICE_URL='http://<hub-host>:3977'   # e.g. http://211.159.223.182:3977
export OFFICE_TOKEN='<same-token-as-the-hub>' # ask the hub operator
```

In a project that contains this repo's `CLAUDE.md`, tell Claude:

```text
Use office relay to register yourself.
```

Or run the client directly (preserving the project path as the agent's cwd):

```bash
OFFICE_AGENT_CWD="$PWD" node ~/.office-relay/office/office.mjs onboard
```

PowerShell:

```powershell
$env:OFFICE_AGENT_CWD = (Get-Location).Path
node "$HOME\.office-relay\office\office.mjs" onboard
```

If identity details are missing it will ask for: agent id, role, host label,
capabilities, optional display name. Manual register:

```bash
node office/office.mjs register linux-baseline-1 "Linux Baseline" \
  --role baseline --host linux-gpu --capabilities gpu,experiments,logs
```

### Communicate

```bash
node office/office.mjs sessions                                   # list registered sessions
node office/office.mjs send leader linux-baseline-1 "Run baseline A, return metrics."
node office/office.mjs send-dir leader project-x "message to whoever is in that folder"
node office/office.mjs inbox leader --mark-read                   # read + clear unread
```

---

## Configuration (environment variables)

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `OFFICE_TOKEN` | both | _(empty)_ | Bearer token. **Required** on a public hub; clients must send the same value. |
| `OFFICE_URL` | client | `http://127.0.0.1:3977` | Hub base URL. |
| `OFFICE_HOST` | hub | `127.0.0.1` | Bind address. `0.0.0.0` to expose. |
| `OFFICE_PORT` | hub | `3977` | Bind port. |
| `OFFICE_STATE_PATH` | hub | next to `relay.mjs` | Where state is persisted (Docker: `/data/office-state.json`). |
| `OFFICE_RATE_LIMIT` | hub | `240` | Max API requests/minute/IP (429 over limit). |
| `OFFICE_MAX_BODY` | hub | `65536` | Max request body bytes (413 over limit). |
| `OFFICE_TRUST_PROXY` | hub | off | Set `1` to read client IP from `X-Forwarded-For`. |
| `OFFICE_IDLE_MS` / `OFFICE_OFFLINE_MS` | hub | `45000` / `180000` | Mark agent idle/offline after inactivity. |
| `OFFICE_AGENT_TTL_MS` | hub | `86400000` | Prune agents unseen this long (24h). |
| `OFFICE_MESSAGE_TTL_MS` / `OFFICE_UNREAD_TTL_MS` | hub | `86400000` / `604800000` | Drop read msgs after 24h, unread after 7d. |
| `OFFICE_MESSAGES_MAX` | hub | `5000` | Hard cap on retained messages. |
| `OFFICE_AGENT_CWD` | client | `process.cwd()` | Project dir advertised as the agent's location. |

---

## Web UI

Open the hub root URL to inspect registered sessions and remove stale ones:

```text
http://<hub-host>:3977/
```

Paste the token into the field at the top. It is an admin list, not the pixel office;
use `pixtuoid` for the visual office (`npm run pix:setup`).

## API

All `/api/*` except `/api/health` require the Bearer token when one is configured, are
rate-limited per client IP, and reject bodies over `OFFICE_MAX_BODY`.

- `GET /api/health` — liveness, no auth.
- `GET /api/state` — agents + recent events. **Does not include message bodies.**
- `POST /api/register` · `POST /api/heartbeat` · `POST|DELETE /api/unregister`
- `POST /api/send` — `{ from, to, body }`; `to` may be an agent id, `dir:<query>`, or `all`.
- `GET /api/inbox?agent=<id>[&unread=false]`
- `POST /api/read` — `{ agent, ids? }`

## Reliability & hardening

- Single in-memory state with atomic (`tmp`+`rename`) persistence — no lost-update
  races when many sessions register/send at once.
- Forced token on public bind, timing-safe token comparison, per-IP rate limit, body
  size cap.
- Message retention (TTL + hard cap) and automatic agent idle/offline/prune, so the
  state file does not grow without bound.

## License

MIT
