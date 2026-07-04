# Agent Intercom — MCP (Part 2)

The client half. A zero-dependency stdio MCP server (`server.mjs`) that any Claude Code
session uses to join the [hub](../hub/) and exchange messages, plus a shared client
(`client.mjs`) and an optional plain CLI (`cli.mjs`).

## Register globally (once per machine)

```bash
claude mcp add agent-intercom --scope user -- node ~/.agent-intercom/mcp/server.mjs
claude mcp list      # agent-intercom → ✔ Connected
```

`--scope user` makes it available in every project/session for this user.

## Use it

In any session: **"Register me to agent intercom."** The agent asks you for the machine
label, this session's role, and the hub URL + token, then calls `office_register`. The
connection is saved to `~/.office-relay-agent.json` (override with `OFFICE_CONFIG`), so
later you can just say "who's in the office?", "message the tex session…", "any mail?".

### Tools

| Tool | Args | Purpose |
|---|---|---|
| `office_register` | agentId, role, host, url, token, [capabilities, displayName, cwd] | Join the hub; saves url+token. |
| `office_status` | — | Saved identity + hub health (token masked). |
| `office_sessions` | — | List registered sessions. |
| `office_send` | to, body, [from] | `to` = agent id, `dir:<folder>`, or `all`. |
| `office_send_file` | to, path, [note, from] | Upload a local file and send it (via hub, ≤100 MB). |
| `office_fetch` | fileId, [savePath] | Download a file another session sent you. |
| `office_inbox` | [agent, unread, markRead] | Read this session's inbox. |
| `office_unregister` | [agentId] | Remove a session. |

## CLI (optional)

Same functionality as a plain command line — handy for scripts/debugging.

```bash
export OFFICE_URL='http://<server-ip>:3977' OFFICE_TOKEN='<token>'
node cli.mjs register <id> [display-name] --role <role> --host <host> --capabilities a,b
node cli.mjs sessions
node cli.mjs send <from> <to> "<message>"
node cli.mjs send-dir <from> <folder-query> "<message>"
node cli.mjs send-file <from> <to> <path> [note...]
node cli.mjs fetch <file-id> [save-path]
node cli.mjs inbox <id> --mark-read
```

## Notes

- `server.mjs` speaks newline-delimited JSON-RPC 2.0 over stdio and has no dependencies,
  so no `npm install` is needed to register it.
- Nothing but protocol messages is written to stdout; diagnostics go to stderr.
