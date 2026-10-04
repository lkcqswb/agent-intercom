#!/usr/bin/env node
// Agent Intercom MCP server (Part 2).
//
// A zero-dependency, stdio JSON-RPC MCP server that lets any Claude Code session
// register itself with the Agent Intercom hub and exchange messages. Register it once,
// globally, with:
//
//   claude mcp add agent-intercom --scope user -- node /ABS/PATH/agent-intercom/mcp/server.mjs
//
// Then in any session: "register me to agent intercom" — the agent collects machine
// info, role, hub URL and token from the user, calls office_register, and is in.
//
// Incoming mail is waited for HERE, in this long-lived process, not by the model:
// an inbox pump long-polls the hub and hands messages to whatever delivery path the
// session has (see docs/delivery-design.md), so no model turn is spent re-arming a
// monitor.
//
// Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0 messages. Nothing except
// protocol messages may be written to stdout; logs go to stderr.

import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  registerAgent,
  heartbeat,
  listState,
  sendMessage,
  getInbox,
  waitInbox,
  markRead,
  unregisterAgent,
  uploadFile,
  downloadFile,
  humanSize,
  health,
  defaultHost,
  formatMessage,
  formatMessages,
  stopHookDecision,
} from "./client.mjs";

const SERVER_INFO = { name: "agent-intercom", version: "0.4.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const MAX_WAIT_S = 86400; // office_wait / waitForReply upper bound
const LEGACY_POLL_MS = 10000; // hubs without /api/inbox/wait are polled this often
const PIGGYBACK_BUDGET = 4000; // max chars of unread mail appended to a tool result
const STOP_HOOK_WAIT_S = 3500; // suggested office_wait timeout for the Stop hook
// The name this server is registered under in the client's MCP config; hook
// snippets must name it.
const MCP_NAME = process.env.OFFICE_MCP_NAME || "agent-intercom";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Presence: once THIS session registers, keep it "online" in the office with a
// periodic heartbeat, and remove it when the session/process ends. Only the
// identity registered in this process is managed, so multiple sessions sharing a
// config file never clobber each other's presence.
let mine = null; // { url, token, agent, waitOnStop }
let client = { name: "" }; // clientInfo from initialize: tells Claude Code from Codex
let beatTimer = null;
function startPresence(url, tokenValue, agent) {
  mine = { url, token: tokenValue, agent };
  if (beatTimer) clearInterval(beatTimer);
  const beat = () =>
    heartbeat(url, tokenValue, {
      id: agent.id,
      name: agent.name,
      status: "online",
      role: agent.role,
      host: agent.host,
      cwd: agent.cwd,
      capabilities: agent.capabilities,
    }).catch(() => {});
  beat();
  beatTimer = setInterval(beat, 30000);
  if (beatTimer.unref) beatTimer.unref();
}
let leaving = false;
async function leaveOffice() {
  if (leaving) return;
  leaving = true;
  pump.key = null;
  for (const waiter of [...waiters]) waiter.resolve(null);
  if (beatTimer) clearInterval(beatTimer);
  if (mine) {
    try {
      await unregisterAgent(mine.url, mine.token, mine.agent.id);
    } catch {}
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Inbox pump: the one consumer of this session's inbox. It long-polls the hub and
// hands each new message to a pending office_wait / waitForReply call that matches
// it. Anything nobody waits for stays unread on the hub and is shown on the next
// office_* tool result (piggyback), by office_inbox, or by the `watch` fallback.
// The pump only ever serves the identity registered in THIS process: the shared
// config file may name another session on this machine, whose mail is not ours.
// ---------------------------------------------------------------------------
const pump = { key: null, cursor: 0, legacy: false };
const waiters = new Set(); // { match(message), wakeOnly, resolve(messages|null) }
const activeWaits = new Map(); // JSON-RPC request id -> cancel(), for notifications/cancelled
const claimed = new Set(); // ids this process already put in front of the model

const isWake = (m) => m.wake !== false;
const unclaimed = (messages) => messages.filter((m) => !claimed.has(m.id));

// Record messages as seen by the model and clear them on the hub.
function handOver(messages) {
  if (!messages.length || !mine) return;
  for (const m of messages) claimed.add(m.id);
  if (claimed.size > 2000) {
    for (const id of [...claimed].slice(0, claimed.size - 1000)) claimed.delete(id);
  }
  markRead(mine.url, mine.token, mine.agent.id, messages.map((m) => m.id)).catch(() => {});
}

function ensurePump() {
  if (!mine || leaving) return;
  const key = `${mine.url}|${mine.agent.id}`;
  if (pump.key === key) return;
  Object.assign(pump, { key, cursor: 0, legacy: false });
  runPump(key, { ...mine }).catch((error) =>
    process.stderr.write(`agent-intercom-mcp: inbox pump stopped: ${error.message}\n`)
  );
}

async function runPump(key, { url, token, agent }) {
  let failures = 0;
  while (pump.key === key) {
    let messages;
    try {
      messages = pump.legacy
        ? await getInbox(url, token, agent.id, true)
        : await waitInbox(url, token, agent.id, { after: pump.cursor });
      failures = 0;
    } catch (error) {
      if (error.status === 404 && !pump.legacy) {
        pump.legacy = true; // hub predates long-poll
        continue;
      }
      failures += 1;
      await sleep(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)));
      continue;
    }
    if (pump.key !== key) return;
    for (const m of messages) pump.cursor = Math.max(pump.cursor, m.seq || 0);
    dispatch(unclaimed(messages));
    if (pump.legacy) await sleep(LEGACY_POLL_MS);
  }
}

function dispatch(messages) {
  for (const waiter of [...waiters]) {
    const matched = messages.filter((m) => !claimed.has(m.id) && waiter.match(m));
    if (!matched.length || (waiter.wakeOnly && !matched.some(isWake))) continue;
    handOver(matched);
    waiter.resolve(matched);
  }
}

// Resolve with matching messages (already unread, or the next to arrive), or
// null after timeoutMs. With wakeOnly, FYI-only mail does not end the wait.
// If the client gives up on the call (e.g. a hook timeout), it sends
// notifications/cancelled; the wait then ends without claiming any mail, so a
// message is never marked read for a caller that is no longer listening.
function waitForMessages({ match, wakeOnly, timeoutMs, onProgress, requestId }) {
  ensurePump();
  return new Promise((resolve) => {
    let done = false;
    const waiter = {
      match,
      wakeOnly,
      resolve(messages) {
        if (done) return;
        done = true;
        waiters.delete(waiter);
        if (requestId !== undefined) activeWaits.delete(requestId);
        clearTimeout(timer);
        clearInterval(ticker);
        resolve(messages);
      },
    };
    waiters.add(waiter);
    if (requestId !== undefined) activeWaits.set(requestId, () => waiter.resolve(null));
    const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
    const ticker = onProgress ? setInterval(onProgress, 30000) : null;
    // Registered first, checked second: mail that landed before this call (or that
    // the pump dispatched a moment before we registered) is still unread here.
    getInbox(mine.url, mine.token, mine.agent.id, true)
      .then((all) => {
        const ready = unclaimed(all).filter(match);
        if (done || !(wakeOnly ? ready.some(isWake) : ready.length)) return;
        handOver(ready);
        waiter.resolve(ready);
      })
      .catch(() => {});
  });
}

// Add any other unread mail (e.g. FYIs that did not end the wait) so one wake-up
// delivers everything that is waiting.
async function withOtherUnread(messages) {
  try {
    const seen = new Set(messages.map((m) => m.id));
    const others = unclaimed(await getInbox(mine.url, mine.token, mine.agent.id, true)).filter(
      (m) => !seen.has(m.id)
    );
    handOver(others);
    return [...messages, ...others].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  } catch {
    return messages;
  }
}

function stopHookConfig() {
  return JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "mcp_tool",
                server: MCP_NAME,
                tool: "office_wait",
                input: { mode: "stop-hook", timeoutSec: STOP_HOOK_WAIT_S },
                timeout: STOP_HOOK_WAIT_S + 100,
              },
            ],
          },
        ],
      },
    },
    null,
    2
  );
}

function sentLine(message) {
  if (message.targetMode === "broadcast") {
    return `Sent ${message.id}: ${message.from} -> all (${message.recipients?.length ?? 0} recipient(s))`;
  }
  const resolved = message.requestedTo !== message.to ? ` (resolved from ${message.requestedTo})` : "";
  return `Sent ${message.id}: ${message.from} -> ${message.to}${resolved}`;
}

// Piggyback: unread mail rides along on whatever office_* tool the model calls
// next, so it is seen without an extra inbox call or a wake-up of its own.
async function appendUnread(result) {
  if (!mine || leaving) return;
  let unread;
  try {
    unread = await Promise.race([
      getInbox(mine.url, mine.token, mine.agent.id, true),
      sleep(3000).then(() => []),
    ]);
  } catch {
    return;
  }
  const fresh = unclaimed(unread);
  if (!fresh.length) return;
  const shown = [];
  let used = 0;
  for (const m of fresh) {
    const text = formatMessage(m);
    if (shown.length && used + text.length > PIGGYBACK_BUDGET) break;
    shown.push(m);
    used += text.length;
  }
  handOver(shown);
  const more = fresh.length - shown.length;
  result.content.push({
    type: "text",
    text:
      `📬 Unread mail for ${mine.agent.id} (now marked read):\n\n${formatMessages(shown)}` +
      (more ? `\n\n(+${more} more unread — call office_inbox)` : ""),
  });
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}
function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

// Keep a long tool call alive for clients that time out idle calls (Claude Code
// resets its MCP idle timer on progress). Only possible if the caller sent a token.
function progressPinger(progressToken, label) {
  if (progressToken === undefined) return undefined;
  let n = 0;
  return () =>
    write({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken, progress: ++n, message: label },
    });
}

function clampSeconds(value, fallback) {
  const n = Number(value);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1), MAX_WAIT_S);
}

const TOOLS = [
  {
    name: "office_register",
    description:
      "Register THIS Claude Code session into the Agent Intercom hub so other sessions can see and message it. " +
      "BEFORE calling, ask the user for and confirm: (1) host = a label for this machine (e.g. macbook, linux-gpu); " +
      "(2) role = this session's duty/positioning (e.g. leader, baseline, tex, reviewer); " +
      "(3) url = the hub address as http://IP:PORT; (4) token = the hub's shared token. " +
      "Also pick a short agentId. Capabilities and displayName are optional. " +
      "The url and token are saved locally, so re-registering later can omit them. " +
      "AFTER registering, follow the delivery note in the result: it says how this session " +
      "will notice incoming messages.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Short unique id for this session, e.g. mac-tex-1" },
        waitOnStop: {
          type: "boolean",
          description:
            "Only if the agent-intercom Stop hook is installed: false stops this session from waiting for mail " +
            "when its turn ends (use for the session the user types into). Default true",
        },
        role: { type: "string", description: "Duty/positioning, e.g. leader, baseline, tex, reviewer" },
        host: { type: "string", description: "Machine label, e.g. macbook, linux-gpu" },
        url: { type: "string", description: "Hub base URL, e.g. http://211.159.223.182:3977 (default: saved)" },
        token: { type: "string", description: "Hub shared bearer token (default: saved)" },
        capabilities: { type: "string", description: "Optional comma list, e.g. gpu,experiments,tex" },
        displayName: { type: "string", description: "Optional human-friendly name" },
        cwd: { type: "string", description: "Optional project directory this session works in" },
      },
      required: ["agentId", "role", "host"],
    },
  },
  {
    name: "office_status",
    description:
      "Show this session's saved Agent Intercom identity and connection (token masked), and ping the hub. " +
      "Use to check whether this session is already registered before registering again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "office_sessions",
    description: "List all sessions currently registered with the Agent Intercom hub.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "office_send",
    description:
      "Send a message to another registered session. 'to' may be an agent id, 'dir:<folder>' to reach " +
      "whoever works in a directory, or 'all' to broadcast. Each message wakes its recipient, so batch " +
      "points into one message and skip acknowledgements. Set waitForReply to block until the answer " +
      "arrives (cheaper than going idle and being woken).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target: agent id, dir:<folder-query>, or all" },
        body: { type: "string", description: "Message text" },
        replyTo: { type: "string", description: "Id of the message you are answering" },
        wake: { type: "boolean", description: "false = FYI: delivered with the recipient's next mail instead of waking it (default true)" },
        waitForReply: { type: "number", description: "Seconds to wait for the reply and return it (default: don't wait)" },
        from: { type: "string", description: "Sender id (defaults to this session's registered id)" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "office_wait",
    description:
      "Block until a message arrives for this session (or timeoutSec passes) and return it. " +
      "Use it when your next step depends on another session. mode=stop-hook is for the " +
      "Stop hook only (returns hook JSON).",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSec: { type: "number", description: "Give up after this many seconds (default 600)" },
        from: { type: "string", description: "Only wait for messages from this agent id" },
        mode: { type: "string", enum: ["text", "stop-hook"], description: "Output format (default text)" },
      },
    },
  },
  {
    name: "office_inbox",
    description:
      "Read this session's unread messages from the hub and mark them read. New mail is also shown " +
      "automatically at the end of other office_* tool results.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Inbox owner id (defaults to this session's registered id)" },
        unread: { type: "boolean", description: "Only unread messages (default true)" },
        markRead: { type: "boolean", description: "Mark the returned messages read (default true for your own inbox)" },
      },
    },
  },
  {
    name: "office_send_file",
    description:
      "Send a FILE to another registered session across machines. Reads a local file, " +
      "uploads it to the hub, and posts a message referencing it; the recipient fetches it " +
      "with office_fetch. 'to' may be an agent id, 'dir:<folder>', or 'all'.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target: agent id, dir:<folder-query>, or all" },
        path: { type: "string", description: "Absolute path of the local file to send" },
        note: { type: "string", description: "Optional message to accompany the file" },
        from: { type: "string", description: "Sender id (defaults to this session's registered id)" },
      },
      required: ["to", "path"],
    },
  },
  {
    name: "office_fetch",
    description:
      "Download a file that another session sent you (the message shows its fileId). " +
      "Saves it to savePath, or to the current directory under its original name.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file id from the message" },
        savePath: { type: "string", description: "Where to save it (default: ./<original-name>)" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "office_unregister",
    description: "Remove a session from the hub. Defaults to this session's registered id.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "Id to remove (defaults to this session)" } },
    },
  },
];

function mask(token) {
  if (!token) return "(none)";
  return token.length <= 8 ? "****" : token.slice(0, 4) + "…" + token.slice(-4);
}

function deliveryNote(agent) {
  if (/codex/i.test(client.name)) {
    return (
      "DELIVERY — Codex has no background wake-up, so: while you work, new mail is shown at the " +
      "end of office_* tool results, and office_wait / office_send(waitForReply) block until mail " +
      "arrives. To also be woken while idle, the USER can install this Stop hook in " +
      "~/.codex/hooks.json (or <project>/.codex/hooks.json for worker projects only) and approve it " +
      "in /hooks. Show it to them; do not edit their config yourself:\n" +
      stopHookConfig() +
      `\nand allow the long tool call in ~/.codex/config.toml:\n  [mcp_servers.${MCP_NAME}]\n` +
      `  tool_timeout_sec = ${STOP_HOOK_WAIT_S + 200}\n` +
      `With it, ending a turn waits up to ${Math.round(STOP_HOOK_WAIT_S / 60)} min for mail instead ` +
      "of going idle. Register the session the user types into with waitOnStop=false."
    );
  }
  return (
    "NEXT — make sure you notice incoming messages. Run this as a BACKGROUND command; it " +
    "long-polls your inbox and exits (printing the message) the moment mail arrives, " +
    "which wakes you to respond — then relaunch it:\n" +
    `  node ${CLI_PATH} watch ${agent.id}\n` +
    "Mail is also shown at the end of any office_* tool result, and office_wait / " +
    "office_send(waitForReply) block until it arrives."
  );
}

async function callTool(name, args = {}, { progressToken, requestId } = {}) {
  const cfg = await loadConfig();
  // This process's registration wins over the shared config file, which only
  // remembers whichever session on this machine registered last.
  const url = args.url || mine?.url || cfg.url;
  const token = args.token || mine?.token || cfg.token;
  const myId = mine?.agent.id || cfg.agent?.id;

  switch (name) {
    case "office_register": {
      const hubUrl = args.url || cfg.url;
      const hubToken = args.token ?? cfg.token;
      if (!hubUrl) return toolText("No hub url saved yet: ask the user for the hub url and token.", true);
      const agent = {
        id: args.agentId,
        name: args.displayName || args.agentId,
        role: args.role,
        host: args.host || defaultHost(),
        capabilities: args.capabilities || "",
        cwd: args.cwd || process.cwd(),
        backend: "mcp",
      };
      const result = await registerAgent(hubUrl, hubToken, agent);
      await saveConfig({
        url: hubUrl,
        token: hubToken,
        agent: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          host: agent.host,
          capabilities: agent.capabilities,
          cwd: agent.cwd,
        },
      });
      startPresence(hubUrl, hubToken, agent); // keep online + auto-leave on exit
      mine.waitOnStop = args.waitOnStop !== false;
      ensurePump();
      return toolText(
        `Registered "${agent.id}" with hub ${hubUrl}.\n` +
          JSON.stringify(result, null, 2) +
          "\n\n" +
          deliveryNote(agent)
      );
    }

    case "office_status": {
      if (!url) return toolText("Not registered yet. Use office_register first.", false);
      let hubOk = "unreachable";
      try {
        const h = await health(url, token);
        hubOk = h.ok ? `ok (auth ${h.auth ? "on" : "off"})` : "error";
      } catch (e) {
        hubOk = `unreachable (${e.message})`;
      }
      const agent = mine?.agent || cfg.agent;
      return toolText(
        `hub:   ${url}  [${hubOk}]\n` +
          `token: ${mask(token)}\n` +
          `agent: ${myId || "(not set)"}` +
          (mine ? "  (registered in this session)" : agent ? "  (saved config; not registered in this session)" : "") +
          (agent ? `\n  role: ${agent.role || ""}\n  host: ${agent.host || ""}\n  cwd:  ${agent.cwd || ""}` : "")
      );
    }

    case "office_sessions": {
      const state = await listState(url, token);
      const agents = Object.values(state.agents || {}).sort(
        (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)
      );
      if (!agents.length) return toolText("No sessions registered.");
      const lines = agents.map((a) => {
        const caps = a.capabilities?.length ? ` caps:${a.capabilities.join(",")}` : "";
        return `• ${a.id} (${a.name || a.id}) [${a.status}] role:${a.role || "-"} host:${a.host || "-"} cwd:${a.cwd || "-"}${caps}`;
      });
      return toolText(`${agents.length} session(s):\n` + lines.join("\n"));
    }

    case "office_send": {
      const from = args.from || myId;
      if (!from) return toolText("No sender id. Register this session first (office_register).", true);
      const waitS = args.waitForReply ? clampSeconds(args.waitForReply, 600) : 0;
      if (waitS && !mine) {
        return toolText("waitForReply needs this session registered here (office_register).", true);
      }
      if (waitS) ensurePump();
      const message = await sendMessage(url, token, {
        from,
        to: args.to,
        body: args.body,
        cwd: (mine?.agent || cfg.agent)?.cwd,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        ...(args.wake === false ? { wake: false } : {}),
      });
      let out = sentLine(message);
      if (waitS) {
        const ids = new Set([message.id, ...(message.ids || [])]);
        const peers = new Set(message.targetMode === "broadcast" ? message.recipients : [message.to]);
        const newer = (m) =>
          message.seq ? (m.seq || 0) > message.seq : (m.createdAt || 0) >= (message.createdAt || 0);
        const replies = await waitForMessages({
          match: (m) => (m.replyTo && ids.has(m.replyTo)) || (peers.has(m.from) && newer(m)),
          wakeOnly: false,
          timeoutMs: waitS * 1000,
          onProgress: progressPinger(progressToken, `waiting for a reply to ${message.id}`),
          requestId,
        });
        out += replies
          ? `\n\nReply:\n\n${formatMessages(replies)}`
          : `\n\nNo reply within ${waitS}s; it will reach you like any other message.`;
      }
      return toolText(out);
    }

    case "office_wait": {
      const stopHook = args.mode === "stop-hook";
      if (stopHook) {
        // A user-level hook fires in every session, registered or not: those that
        // are not (or opted out) end their turn normally. Empty output = allow stop.
        if (!mine || !mine.waitOnStop) return { ...toolText(""), raw: true };
      } else if (!mine) {
        return toolText("This session is not registered here; call office_register first.", true);
      }
      const waitS = clampSeconds(args.timeoutSec, stopHook ? STOP_HOOK_WAIT_S : 600);
      const from = args.from ? String(args.from) : "";
      const found = await waitForMessages({
        match: (m) => !from || m.from === from,
        wakeOnly: true,
        timeoutMs: waitS * 1000,
        onProgress: progressPinger(progressToken, "waiting for mail"),
        requestId,
      });
      const messages = found && (await withOtherUnread(found));
      if (stopHook) return { ...toolText(messages ? stopHookDecision(mine.agent.id, messages) : ""), raw: true };
      return toolText(messages ? formatMessages(messages) : `No messages within ${waitS}s.`);
    }

    case "office_inbox": {
      const agent = args.agent || myId;
      if (!agent) return toolText("No inbox owner. Register this session first (office_register).", true);
      const unread = args.unread !== false;
      const own = Boolean(mine) && agent === mine.agent.id;
      const messages = await getInbox(url, token, agent, unread);
      let out = messages.length
        ? formatMessages(messages)
        : `No ${unread ? "unread " : ""}messages for ${agent}.`;
      const shouldMark = args.markRead ?? own;
      if (shouldMark && messages.length) {
        if (own) handOver(messages);
        else await markRead(url, token, agent, messages.map((m) => m.id));
        out += `\n\n(marked ${messages.length} read)`;
      }
      return toolText(out);
    }

    case "office_send_file": {
      const from = args.from || myId;
      if (!from) return toolText("No sender id. Register this session first (office_register).", true);
      if (!args.path) return toolText("A local file path is required.", true);
      let buffer;
      try {
        buffer = await readFile(args.path);
      } catch (error) {
        return toolText(`Cannot read ${args.path}: ${error.message}`, true);
      }
      const name = path.basename(args.path);
      const up = await uploadFile(url, token, { name, from, to: args.to, buffer });
      const note = args.note ? args.note + " " : "";
      const message = await sendMessage(url, token, {
        from,
        to: args.to,
        body: `${note}📎 ${name} (${humanSize(up.size)}) — fetch with office_fetch fileId=${up.id}`,
        cwd: (mine?.agent || cfg.agent)?.cwd,
        file: { id: up.id, name: up.name, size: up.size },
      });
      return toolText(
        `Sent file "${name}" (${humanSize(up.size)}) to ${message.to} as message ${message.id} (fileId ${up.id}).`
      );
    }

    case "office_fetch": {
      if (!args.fileId) return toolText("A fileId is required.", true);
      const dl = await downloadFile(url, token, args.fileId);
      const savePath = args.savePath || path.join(process.cwd(), dl.name || args.fileId);
      await writeFile(savePath, dl.buffer);
      return toolText(`Saved ${humanSize(dl.size)} to ${savePath}`);
    }

    case "office_unregister": {
      const id = args.agentId || myId;
      if (!id) return toolText("No id to unregister.", true);
      const result = await unregisterAgent(url, token, id);
      if (mine && id === mine.agent.id) {
        pump.key = null;
        if (beatTimer) clearInterval(beatTimer);
        mine = null;
      }
      return toolText(`Removed ${result.id}${result.existed ? "" : " (was not registered)"}`);
    }

    default:
      return toolText(`unknown tool: ${name}`, true);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  try {
    if (method === "initialize") {
      client = params?.clientInfo || client;
      return reply(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === "tools/list") {
      return reply(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments || {}, {
        progressToken: params?._meta?.progressToken,
        requestId: id,
      });
      // Hook output must stay exactly what the hook expects.
      if (result.raw) delete result.raw;
      else await appendUnread(result);
      return reply(id, result);
    }
    if (method === "notifications/cancelled") {
      activeWaits.get(params?.requestId)?.();
      return;
    }
    if (method === "ping") {
      return reply(id, {});
    }
    // Notifications (no id) such as notifications/initialized need no response.
    if (!isRequest) return;
    return replyError(id, -32601, `method not found: ${method}`);
  } catch (error) {
    if (isRequest) {
      // Surface tool failures as tool results so the agent can react, not as
      // transport errors.
      if (method === "tools/call") return reply(id, toolText(`office: ${error.message}`, true));
      return replyError(id, -32603, error.message);
    }
    process.stderr.write(`agent-intercom-mcp: ${error.stack || error.message}\n`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`agent-intercom-mcp: bad JSON: ${line}\n`);
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", leaveOffice);
process.on("SIGTERM", leaveOffice);
process.on("SIGINT", leaveOffice);
process.stderr.write(`agent-intercom-mcp ${SERVER_INFO.version} ready on stdio\n`);
