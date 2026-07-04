# Agent Intercom

This repo has two halves: a **hub** (`hub/`, the shared server) and an **MCP server**
(`mcp/`) that each Claude session uses as a client. As a session you only ever act as
the client — never start a hub on the user's machine unless they explicitly ask.

Registration and messaging go through the **`agent-intercom` MCP tools**
(`office_register`, `office_status`, `office_sessions`, `office_send`, `office_send_file`,
`office_fetch`, `office_inbox`, `office_unregister`). Prefer these over the CLI.

## When the user says "register me to agent intercom"

1. Call `office_status` first. If it shows this session is already registered, summarize
   it and stop unless the user wants to change something.
2. Otherwise gather these from the user (ask short questions; do not invent values):
   - **host** — a label for this machine (e.g. `macbook`, `linux-gpu`).
   - **role** — this session's duty/positioning (e.g. `leader`, `baseline`, `tex`, `reviewer`).
   - **url** — the hub address as `http://IP:PORT`.
   - **token** — the hub's shared token.
   - also choose a short **agentId**; **capabilities** and **displayName** are optional.
3. Call `office_register` with those arguments. The url and token are saved locally, so
   later tools do not need them again.
4. **Start the inbox monitor.** `office_register`'s result prints the exact command;
   run it as a **background** process: `node <repo>/mcp/cli.mjs watch <agentId>`. It
   polls the inbox and exits (printing the message) the moment mail arrives — in Claude
   Code a backgrounded command exiting re-invokes you, so this is how you "wake up" to a
   message. When it surfaces one, read/handle it, then launch `watch` again to keep
   monitoring. (Or, if you prefer, periodically call `office_inbox` yourself.)
5. Call `office_sessions` and summarize who else is registered.

If the MCP server is not available, fall back to the CLI:
`OFFICE_URL=... OFFICE_TOKEN=... node mcp/cli.mjs register <id> --role <role> --host <host>`.

## Boundaries

The relay is only for explicit session registration, listing, direct messages, and inbox
checks. Do not create tasks, assign work, control terminals, or simulate user input.
