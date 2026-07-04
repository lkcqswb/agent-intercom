# Agent Intercom

A tiny system that lets long-running Claude Code sessions — across machines — see each
other and exchange messages, only when you explicitly tell them to.

It comes in **two halves**:

| Half | Path | What it is | Where it runs |
|---|---|---|---|
| **1. Hub** | [`hub/`](hub/) | The exchange (中转站): an HTTP server holding the agent list + inboxes. | **Once**, on a box every machine can reach (a VPS, a LAN host). |
| **2. MCP** | [`mcp/`](mcp/) | A globally-registered MCP server each Claude session uses to register, send, and read its inbox. | On **every** machine, inside Claude Code. |

You set up the hub once to get an **IP + token**, then register the MCP on each machine
and hand it that IP + token when a session joins.

Design intent: sessions join only when told to; the hub only tracks registered agents
and direct messages; it never scans terminals, creates tasks, assigns work, or
simulates input.

---

## Part 1 — Set up the Hub (once) → get an IP + token

Run this on a server every session can reach.

### Docker (recommended)

```bash
git clone https://github.com/lkcqswb/agent-intercom.git
cd agent-intercom/hub
printf 'OFFICE_TOKEN=%s\nOFFICE_PORT=3977\n' "$(openssl rand -hex 24)" > .env   # generate a strong token
docker compose up -d --build
docker compose logs -f          # expect: "running at http://0.0.0.0:3977 (auth: on)"
cat .env                        # note your OFFICE_TOKEN
```

- Binds `0.0.0.0:3977` and **refuses to start on a public host without `OFFICE_TOKEN`**
  (override only with `OFFICE_ALLOW_NO_TOKEN=1`).
- State persists in the `office-data` Docker volume across restarts.
- Host networking (Linux) lets the hub see real client IPs; a commented bridge-mode
  block in `hub/docker-compose.yml` covers macOS/Windows Docker Desktop.

**Open the port** in your cloud firewall / security group (Tencent Cloud, AWS, Aliyun, …)
so clients can reach `:3977`, or front it with HTTPS (Caddy / nginx / Cloudflare Tunnel /
Tailscale).

Update after pulling new code: `git pull --ff-only && docker compose up -d --build`.

### Without Docker

```bash
OFFICE_HOST=0.0.0.0 OFFICE_PORT=3977 OFFICE_TOKEN='long-random-secret' npm run office
```

**You now have what every session needs:**

```text
OFFICE_URL   = http://<server-ip>:3977
OFFICE_TOKEN = <the token in hub/.env>
```

---

## Part 2 — Register the MCP (once per machine), then join from any session

Register the MCP server globally so every Claude Code session on this machine has it:

```bash
git clone https://github.com/lkcqswb/agent-intercom.git ~/.agent-intercom   # if not already
claude mcp add agent-intercom --scope user -- node ~/.agent-intercom/mcp/server.mjs
claude mcp list      # agent-intercom → ✔ Connected
```

Then, in **any** session, just say:

```text
Register me to agent intercom.
```

The agent will ask you for the machine label, this session's role/duty, and the hub's
URL + token, then call the `office_register` tool. The URL and token are saved locally
(`~/.office-relay-agent.json`), so afterwards you only say things like:

```text
Who else is in the office?            → office_sessions
Tell the tex session to rebuild.      → office_send
Any messages for me?                  → office_inbox
```

### MCP tools

| Tool | Purpose |
|---|---|
| `office_register` | Register this session (asks for host, role, url, token). |
| `office_status` | Show saved identity + hub health (token masked). |
| `office_sessions` | List all registered sessions. |
| `office_send` | Message an agent id, `dir:<folder>`, or `all`. |
| `office_send_file` | Send a local file to another session (via the hub, ≤100 MB). |
| `office_fetch` | Download a file another session sent you (by its fileId). |
| `office_inbox` | Read this session's inbox (optionally mark read). |
| `office_unregister` | Remove a session from the hub. |

### Optional CLI

`mcp/cli.mjs` is the same functionality as a plain command line (handy for scripts/debug):

```bash
export OFFICE_URL='http://<server-ip>:3977' OFFICE_TOKEN='<token>'
node ~/.agent-intercom/mcp/cli.mjs register linux-baseline-1 "Linux Baseline" --role baseline --host linux-gpu --capabilities gpu,logs
node ~/.agent-intercom/mcp/cli.mjs sessions
node ~/.agent-intercom/mcp/cli.mjs send leader linux-baseline-1 "Run baseline A."
node ~/.agent-intercom/mcp/cli.mjs send-file leader linux-baseline-1 ./config.yaml "use this"
node ~/.agent-intercom/mcp/cli.mjs fetch <file-id> ./saved.yaml
node ~/.agent-intercom/mcp/cli.mjs inbox leader --mark-read
```

---

## Configuration (environment variables)

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `OFFICE_TOKEN` | both | _(empty)_ | Bearer token. **Required** on a public hub; clients send the same value. |
| `OFFICE_VIEW_TOKEN` | hub | _(empty)_ | Optional **read-only** token for the office UI / shareable preview. Can `GET /api/feed` + `/api/state` only — no send/register/remove. |
| `OFFICE_URL` | client | `http://127.0.0.1:3977` | Hub base URL (CLI / saved by the MCP at register time). |
| `OFFICE_CONFIG` | mcp | `~/.office-relay-agent.json` | Where the MCP saves this session's identity + connection. |
| `OFFICE_HOST` | hub | `127.0.0.1` | Bind address. `0.0.0.0` to expose. |
| `OFFICE_PORT` | hub | `3977` | Bind port. |
| `OFFICE_STATE_PATH` | hub | next to `relay.mjs` | Persisted state (Docker: `/data/office-state.json`). |
| `OFFICE_RATE_LIMIT` | hub | `240` | Max API requests/minute/IP (429 over limit). |
| `OFFICE_MAX_BODY` | hub | `65536` | Max request body bytes (413 over limit). |
| `OFFICE_MAX_FILE` | hub | `104857600` | Max upload file bytes (100 MB). |
| `OFFICE_FILES_PATH` | hub | `<state dir>/files` | Where uploaded files are stored (Docker: `/data/files`). |
| `OFFICE_FILE_TTL_MS` | hub | `86400000` | Delete uploaded files after this long (24h). |
| `OFFICE_TRUST_PROXY` | hub | off | `1` to read client IP from `X-Forwarded-For`. |
| `OFFICE_IDLE_MS` / `OFFICE_OFFLINE_MS` | hub | `45000` / `180000` | Mark agent idle / offline after inactivity. |
| `OFFICE_AGENT_TTL_MS` | hub | `86400000` | Prune agents unseen this long (24h). |
| `OFFICE_MESSAGE_TTL_MS` / `OFFICE_UNREAD_TTL_MS` | hub | `86400000` / `604800000` | Drop read msgs after 24h, unread after 7d. |
| `OFFICE_MESSAGES_MAX` | hub | `5000` | Hard cap on retained messages. |

## Web office (the live UI)

The hub root URL is a self-contained pixel **office**: each connected session is a
character at a desk (avatar coloured by role, status dot), appearing when it joins and
fading out when it leaves, with a live **Activity** panel showing the message stream
(who → who) and animated bubbles when someone speaks. It polls `/api/feed` every ~1.5s.

Open it with the token in the URL fragment (preferred — the `#` part is never sent to
the server or proxies) or the query string:

```text
http://<server-ip>:3977/#token=<OFFICE_VIEW_TOKEN>
http://<server-ip>:3977/?token=<OFFICE_VIEW_TOKEN>
```

Use the **read-only** `OFFICE_VIEW_TOKEN` for a shareable preview — the page can watch
but not send or remove. Open it with the full `OFFICE_TOKEN` instead and the page shows
an `admin` badge with per-agent remove. (For a local terminal pixel office, `pixtuoid`
remains available separately.)

## API

All `/api/*` except `/api/health` require a token when configured, are rate-limited per
client IP, and reject bodies over `OFFICE_MAX_BODY`. Reads (`/api/feed`, `/api/state`)
also accept the read-only `OFFICE_VIEW_TOKEN`; everything else needs the full token.

- `GET /api/health` — liveness, no auth.
- `GET /api/state` — agents + recent events. **Does not include message bodies.**
- `GET /api/feed?limit=N` — agents + recent message stream (powers the office UI).
- `POST /api/register` · `POST /api/heartbeat` · `POST|DELETE /api/unregister`
- `POST /api/send` — `{ from, to, body, file? }`; `to` may be an agent id, `dir:<query>`, or `all`.
- `GET /api/inbox?agent=<id>[&unread=false]`
- `POST /api/read` — `{ agent, ids? }`
- `POST /api/file?name=&from=&to=` — upload raw bytes (≤ `OFFICE_MAX_FILE`), returns `{ id, name, size }`.
- `GET /api/file/<id>` — download the file (full token only, not the view token).

## Reliability & hardening

- Single in-memory state with atomic (`tmp`+`rename`) persistence — no lost-update
  races when many sessions register/send at once.
- Forced token on public bind, timing-safe token comparison, per-IP rate limit, body cap.
- Message retention (TTL + hard cap) and automatic agent idle/offline/prune, so the
  state file does not grow without bound.

## License

MIT
