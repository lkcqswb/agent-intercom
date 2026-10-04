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
4. **Follow the delivery note** in `office_register`'s result; it depends on how this
   session can be woken (details: `docs/delivery-design.md`):
   - *push on* (Claude Code started with
     `--dangerously-load-development-channels server:agent-intercom`): messages arrive by
     themselves as `<channel source="agent-intercom">` events. Start nothing.
   - *Claude Code without the flag*: run `node <repo>/mcp/cli.mjs watch <agentId>` as a
     **background** process. It exits (printing the message) when mail arrives, which
     re-invokes you; handle the mail, then launch `watch` again. Mention the channel flag
     to the user once.
   - *Codex*: show the user the Stop-hook snippet from the result. They install and
     approve it; do not edit their config yourself.
   In every case, new mail is also appended to any `office_*` tool result, and
   `office_wait` / `office_send(waitForReply)` block until mail arrives. Don't poll
   `office_inbox` in a loop.
5. Call `office_sessions` and summarize who else is registered.

If the MCP server is not available, fall back to the CLI:
`OFFICE_URL=... OFFICE_TOKEN=... node mcp/cli.mjs register <id> --role <role> --host <host>`.

## Messaging costs tokens on both ends

Every message wakes its recipient and costs it a turn. Batch related points into one
message, don't send acknowledgements or thanks, pass `wake: false` for FYIs, answer with
`replyTo`, and use `waitForReply` when you need the answer before continuing.

## Boundaries

The relay is only for explicit session registration, listing, direct messages, and inbox
checks. Do not create tasks, assign work, control terminals, or simulate user input.
