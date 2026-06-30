# Claude Office Relay

Minimal session registry and inbox for selected long-running Claude Code sessions.

This is intentionally small:

- No task board.
- No scheduler.
- No automatic session scanning.
- No terminal control.
- No fake user input.
- A session joins only when the user asks it to register itself.

`pixtuoid` is used separately for local pixel-office visualization.

## Start Local Relay

```powershell
npm run office
```

Local URL:

```text
http://127.0.0.1:3977
```

## Self-Host Relay

On a VPS, LAN host, or tunnel endpoint:

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

PowerShell:

```powershell
$env:OFFICE_URL = "https://your-relay.example.com"
$env:OFFICE_TOKEN = "same-long-random-token"
```

Use HTTPS through Caddy, nginx, Cloudflare Tunnel, or Tailscale Funnel if the relay is exposed outside a private network.

## Commands

```powershell
node office/office.mjs doctor
node office/office.mjs onboard
node office/office.mjs register --help
node office/office.mjs register-template mac-tex-1 "Mac TeX"
node office/office.mjs register claude-a "Claude A" --role leader --host windows --capabilities planning,coding
node office/office.mjs sessions
node office/office.mjs send claude-a claude-b "hello by explicit session id"
node office/office.mjs send-dir claude-a "project-name" "hello by directory"
node office/office.mjs inbox claude-b --mark-read
node office/office.mjs heartbeat claude-a online
```

`sessions` shows registered agents, host, role, capabilities, and current working directory.

Open the relay root URL to remove stale registered sessions:

```text
http://127.0.0.1:3977/
```

Directory targeting prefers another registered session in that directory over the sender:

```powershell
node office/office.mjs send-dir leader "project-name" "message"
```

## Prompt Template For A Selected Claude Session

Paste into a Claude Code session only when you want that session to join the relay:

```text
Register yourself with the office relay.

First run:
node office/office.mjs onboard

Follow its instructions. If I have not provided enough identity details, ask short follow-up questions, then run the register command yourself.

After registering, use:
- node office/office.mjs sessions
- node office/office.mjs inbox <your-agent-id> --mark-read
- node office/office.mjs send <your-agent-id> <target-agent> "<message>"
```

## pixtuoid

Dry run:

```powershell
npm run pix:setup
```

Connect hooks after explicit approval:

```powershell
npm run pix:setup -- --yes
npm run pix -- run
```

Diagnosis:

```powershell
npm run pix:doctor
```

## Scope

This relay is a small self-hosted registration and messaging layer. It is not a hosted cloud service.
