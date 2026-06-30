# Office Relay

Minimal explicit session registry and inbox relay for long-running Claude Code sessions.

This package is intentionally small:

- Sessions join only when the user tells them to register.
- The relay only tracks registered agents and direct messages.
- It does not scan terminals, create tasks, assign work, or simulate user input.
- Use `pixtuoid` separately for local pixel-office visualization.

## Install

```bash
git clone https://github.com/<owner>/office-relay.git
cd office-relay
npm install
```

## Start A Relay

Local development:

```bash
npm run office
```

Self-hosted:

```bash
export OFFICE_HOST=0.0.0.0
export OFFICE_PORT=3977
export OFFICE_TOKEN='replace-with-a-long-random-token'
npm run office
```

Client machines:

```bash
export OFFICE_URL='https://your-relay.example.com'
export OFFICE_TOKEN='same-long-random-token'
```

Use HTTPS through Caddy, nginx, Cloudflare Tunnel, or Tailscale Funnel when exposing the relay outside a private network.

## Register A Claude Session

In a project that contains this repo's `CLAUDE.md`, tell Claude:

```text
用 office relay 注册自己
```

Claude should run:

```bash
node office/office.mjs onboard
```

If identity details are missing, it will ask for:

- agent id
- role
- host label
- capabilities
- optional display name

Manual example:

```bash
node office/office.mjs register linux-baseline-1 "Linux Baseline" --role baseline --host linux-gpu --capabilities gpu,experiments,logs
```

## Communication

List registered sessions:

```bash
node office/office.mjs sessions
```

Send a message:

```bash
node office/office.mjs send leader linux-baseline-1 "Run baseline A and return metrics plus log path."
```

Read inbox:

```bash
node office/office.mjs inbox leader --mark-read
```

## pixtuoid

Dry run:

```bash
npm run pix:setup
```

Connect hooks after explicit approval:

```bash
npm run pix:setup -- --yes
npm run pix -- run
```

## API

- `GET /api/health`
- `GET /api/state`
- `POST /api/register`
- `POST /api/heartbeat`
- `POST /api/send`
- `GET /api/inbox?agent=<id>`
- `POST /api/read`

## License

MIT
