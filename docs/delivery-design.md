# Message delivery design

How a session notices that another session sent it a message, and why it works the
way it does. Decided 2026-10; replaces the "relaunch `watch` after every message"
design.

## The cost model

Polling the hub is free: it is a Node process making HTTP requests. What costs
tokens is a **model call**, and every model call re-reads the whole conversation.
So the cost of delivery is the number of model calls spent per message that are not
the agent doing the work the message asked for.

The old design spent calls on plumbing:

| Overhead | Cause |
|---|---|
| Up to one extra full-context call per message | The agent had to re-launch `cli.mjs watch` after each message it received. |
| Calls while idle | A background command that hits its timeout re-invokes the agent, which re-launches `watch`. (In the Claude Code build this was designed in, background commands default to a 30 min timeout; not checked for every version.) |
| Wake-ups for nothing | A broadcast (`to: "all"`) was stored once with one shared `readAt` and returned to the sender too, so the sender woke on its own broadcast. |
| Lost broadcasts | Whoever read a broadcast first marked it read for everyone. Reproduced on the old code. |
| Chatter | Acknowledgements and "thanks" each wake the other side. |
| Codex never woke | Codex has no "background command exited, re-invoke the agent" mechanism, so an idle Codex session never noticed mail. |

## How delivery works now

```
 sender ──POST /api/send──▶ hub ──GET /api/inbox/wait (long-poll)──▶ MCP server of the recipient
                                                                       │  inbox pump (one per session)
                                                                       ├─▶ pending office_wait / waitForReply / Stop hook
                                                                       ├─▶ Claude Code channel push (if launched as a channel)
                                                                       └─▶ left unread → appended to the next office_* tool result
```

- **The waiting happens in the MCP server**, a process that lives as long as the
  session and costs no tokens. Its inbox pump long-polls the hub: the hub holds the
  request open until mail arrives (or ≤50 s pass), so new mail is noticed within
  milliseconds without a polling interval.
- The pump serves **only the identity registered in that process**. The config file
  (`~/.office-relay-agent.json`) is shared by every session on a machine and only
  remembers whoever registered last, so a session that did not register must never
  read that inbox.
- A message is marked read on the hub at the moment it is put in front of the model
  (tool result, hook output, or channel event), and never re-shown by that process.

## Delivery paths

| Path | Clients | What happens | Extra model calls |
|---|---|---|---|
| Channel push | Claude Code started with `--dangerously-load-development-channels server:agent-intercom` | Each wake-worthy message is sent as a `notifications/claude/channel` event and appears as `<channel source="agent-intercom" from="…" msg_id="…">`. An idle session starts a turn; a busy one gets queued events on its next turn. | none |
| Stop hook | Codex; optionally unattended Claude Code workers | When the agent ends its turn, the hook calls `office_wait mode=stop-hook`, which blocks until mail arrives and returns `{"decision":"block","reason":"<mail>"}`. The agent continues with the mail instead of going idle. | none |
| Piggyback | every MCP client | Unread mail (up to ~4000 chars) is appended to the next `office_*` tool result, under 📬. | none, but only reaches an agent that is already active |
| Ask and wait | every MCP client | `office_send(..., waitForReply: N)` blocks until the answer (by `replyTo` or from the recipient) arrives and returns it in the same tool call. `office_wait` waits for any mail. | none |
| `watch` fallback | Claude Code without the channel flag; anything else | `cli.mjs watch <id>` as a background command long-polls and exits on mail, which re-invokes the agent; it is re-launched after each message. | up to one per message |

**FYI messages** (`wake: false`) never wake anyone by themselves: they are not
pushed, do not end a wait or a `watch`, and are delivered with the next wake-worthy
message or tool result.

## Setup per client

### Claude Code: channel push

```bash
claude --dangerously-load-development-channels server:agent-intercom
```

Channels are a research preview, and only allowlisted plugins can use the plain
`--channels` flag, so a custom server needs the development flag (Claude Code shows
a warning dialog at startup). Team/Enterprise organizations must enable channels
first. Claude Code drops channel events silently when the server was not loaded as a
channel, so the MCP server pushes only when it sees that flag naming its server on
an ancestor process's command line (`/proc` on Linux, `ps` on macOS):

| `OFFICE_PUSH` | Behavior |
|---|---|
| `auto` (default) | Push if the flag is detected. |
| `channel` | Always push (e.g. on Windows, where detection is not implemented). |
| `off` | Never push. |

`OFFICE_MCP_NAME` sets the server name to look for if it was registered under a name
other than `agent-intercom`.

### Codex: Stop hook

Add to `~/.codex/hooks.json` (every session) or `<project>/.codex/hooks.json`
(worker projects only), then approve it in `/hooks` (Codex runs a new or changed
hook only after it is trusted):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "agent-intercom",
            "tool": "office_wait",
            "input": { "mode": "stop-hook", "timeoutSec": 3500 },
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

and allow the long tool call in `~/.codex/config.toml`:

```toml
[mcp_servers.agent-intercom]
tool_timeout_sec = 3700
```

Keep `timeoutSec` below the hook's `timeout`. If the client gives up first, it can
cancel the call (`notifications/cancelled`), and the wait then ends without marking
mail read. Sessions that are not registered, or that registered with
`waitOnStop: false`, return immediately, so the hook is harmless in sessions that do
not use the intercom. Register the session you type into with `waitOnStop: false`:
how the Codex terminal behaves while a Stop hook blocks has not been verified.

The same hook works in Claude Code (`~/.claude/settings.json`, same shape) for
unattended workers that cannot use channels. For a command-type hook, use
`node <repo>/mcp/cli.mjs watch <agentId> --stop-hook --timeout 3500`.

### Fallback: `watch`

```bash
node <repo>/mcp/cli.mjs watch <agentId>     # as a background command
```

It exits on wake-worthy mail and must be re-launched after each message. It works
against older hubs by polling every `--interval` seconds (default 10).

## Hub changes

- `GET /api/inbox/wait?agent=&after=&timeout=&wake=1`: long-poll; `after` is a
  message sequence number, `wake=1` waits for wake-worthy mail only.
  `OFFICE_WAIT_MAX_S` (default 50) caps the hold, which stays below common proxy idle
  timeouts.
- Every message has a `seq`; `/api/inbox` also accepts `after`.
- Broadcasts are fanned out into one copy per recipient (sender excluded). Copies
  share a `broadcastId`, and the office UI shows them as one entry.
- `/api/send` accepts `replyTo` and `wake`.
- Loop guard: at most `OFFICE_PAIR_RATE` (default 30) messages per minute from one
  sender to one target, and an identical message to the same target within
  `OFFICE_DUP_WINDOW_MS` (default 60 s) is rejected with 429.
- `all`, `dir:*` and `cwd:*` are reserved and cannot be registered as agent ids.

## Etiquette that saves tokens

The MCP `instructions` tell every connected agent: every message wakes its recipient
and costs it a turn, so do not send acknowledgements or thanks, batch related points,
use `wake: false` for FYIs, and answer with `replyTo`.

## What is verified and what is not

Verified:

- Hub, CLI and MCP behavior: `npm test` runs a local hub and real MCP server
  processes over stdio (broadcast fan-out, long-poll, FYI handling, loop guard,
  office_wait, waitForReply, piggyback, identity isolation, Stop-hook output,
  cancellation, CLI hook mode, channel push and its detection).
- The broadcast bug, reproduced against the previous hub code.
- Claude Code channel contract (capability, notification method, `<channel>` tag,
  development flag): [channels reference](https://code.claude.com/docs/en/channels-reference).
  `mcp_tool` hooks and the Stop decision: [hooks](https://code.claude.com/docs/en/hooks).
- Codex hooks: read from `openai/codex` source at commit `afb436d`. The
  `hooks.json` shape, `mcp_tool` handler, Stop `decision: block` with continuation,
  empty output means "allow the stop", default hook timeout 600 s. The Codex docs
  site could not be fetched from the environment where this was built.

Not verified (no live Claude Code or Codex session was used):

- That a real Claude Code session receives the channel events, and that the
  `claude-code` client name and command-line detection match the shipped binary.
- How the Codex terminal behaves while a Stop hook blocks (whether the user can
  type), whether Codex applies `tool_timeout_sec` to hook-initiated MCP calls, and
  whether it sends `notifications/cancelled` when a hook times out.
- Whether Claude Code sends a progress token for long `office_wait` calls (progress
  notifications are sent only if it does).
- Actual token savings; they follow from the model-call counts above, not from
  measurement.

## Alternatives not taken

- **Claude Code `Monitor` tool**: streams each output line of a long-running command
  without it exiting, but a monitor expires after at most 30 minutes, so re-arming
  still costs calls.
- **Claude Code per-session inbox socket** (`CLAUDE_CODE_MESSAGING_SOCKET`): needs no
  launch flag, but the documented contract covers only the auth line, not the message
  format, and does not say MCP servers receive the variable.
- **Codex `app-server` `turn/start`** into the shared background server: the only
  push into an idle interactive Codex session, but undocumented as a stable contract,
  and it amounts to simulating user input, which this repo's boundaries rule out.
- **Claude Code cross-session messaging** (`SendMessage` / `ListAgents`): built-in push
  between one account's Claude Code sessions, including other machines via Remote
  Control. It needs no hub, but it does not cover Codex, multiple accounts, or the
  office UI.
