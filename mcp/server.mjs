#!/usr/bin/env node
// Office Relay MCP server (Part 2).
//
// A zero-dependency, stdio JSON-RPC MCP server that lets any Claude Code session
// register itself with the Office Relay hub and exchange messages. Register it once,
// globally, with:
//
//   claude mcp add office-relay --scope user -- node /ABS/PATH/office-relay/mcp/server.mjs
//
// Then in any session: "register me to office relay" — the agent collects machine
// info, role, hub URL and token from the user, calls office_register, and is in.
//
// Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0 messages. Nothing except
// protocol messages may be written to stdout; logs go to stderr.

import {
  loadConfig,
  saveConfig,
  registerAgent,
  heartbeat,
  listState,
  sendMessage,
  getInbox,
  markRead,
  unregisterAgent,
  health,
  defaultHost,
} from "./client.mjs";

const SERVER_INFO = { name: "office-relay", version: "0.2.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

// Presence: once THIS session registers, keep it "online" in the office with a
// periodic heartbeat, and remove it when the session/process ends. Only the
// identity registered in this process is managed, so multiple sessions sharing a
// config file never clobber each other's presence.
let mine = null; // { url, token, agent }
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
  if (beatTimer) clearInterval(beatTimer);
  if (mine) {
    try {
      await unregisterAgent(mine.url, mine.token, mine.agent.id);
    } catch {}
  }
  process.exit(0);
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

const TOOLS = [
  {
    name: "office_register",
    description:
      "Register THIS Claude Code session into the Office Relay hub so other sessions can see and message it. " +
      "BEFORE calling, ask the user for and confirm: (1) host = a label for this machine (e.g. macbook, linux-gpu); " +
      "(2) role = this session's duty/positioning (e.g. leader, baseline, tex, reviewer); " +
      "(3) url = the hub address as http://IP:PORT; (4) token = the hub's shared token. " +
      "Also pick a short agentId. Capabilities and displayName are optional. " +
      "The url and token are saved locally so later tools do not need them again.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Short unique id for this session, e.g. mac-tex-1" },
        role: { type: "string", description: "Duty/positioning, e.g. leader, baseline, tex, reviewer" },
        host: { type: "string", description: "Machine label, e.g. macbook, linux-gpu" },
        url: { type: "string", description: "Hub base URL, e.g. http://211.159.223.182:3977" },
        token: { type: "string", description: "Hub shared bearer token" },
        capabilities: { type: "string", description: "Optional comma list, e.g. gpu,experiments,tex" },
        displayName: { type: "string", description: "Optional human-friendly name" },
        cwd: { type: "string", description: "Optional project directory this session works in" },
      },
      required: ["agentId", "role", "host", "url", "token"],
    },
  },
  {
    name: "office_status",
    description:
      "Show this session's saved Office Relay identity and connection (token masked), and ping the hub. " +
      "Use to check whether this session is already registered before registering again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "office_sessions",
    description: "List all sessions currently registered with the Office Relay hub.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "office_send",
    description:
      "Send a message to another registered session. 'to' may be an agent id, 'dir:<folder>' to reach " +
      "whoever works in a directory, or 'all' to broadcast. 'from' defaults to this session's registered id.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target: agent id, dir:<folder-query>, or all" },
        body: { type: "string", description: "Message text" },
        from: { type: "string", description: "Sender id (defaults to this session's registered id)" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "office_inbox",
    description:
      "Read this session's inbox from the hub. Defaults to unread only; set markRead to clear them after reading.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Inbox owner id (defaults to this session's registered id)" },
        unread: { type: "boolean", description: "Only unread messages (default true)" },
        markRead: { type: "boolean", description: "Mark the returned messages read (default false)" },
      },
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

async function callTool(name, args = {}) {
  const cfg = await loadConfig();
  const url = args.url || cfg.url;
  const token = args.token || cfg.token;
  const myId = cfg.agent?.id;

  switch (name) {
    case "office_register": {
      const agent = {
        id: args.agentId,
        name: args.displayName || args.agentId,
        role: args.role,
        host: args.host || defaultHost(),
        capabilities: args.capabilities || "",
        cwd: args.cwd || process.cwd(),
        backend: "mcp",
      };
      const result = await registerAgent(args.url, args.token, agent);
      await saveConfig({
        url: args.url,
        token: args.token,
        agent: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          host: agent.host,
          capabilities: agent.capabilities,
          cwd: agent.cwd,
        },
      });
      startPresence(args.url, args.token, agent); // keep online + auto-leave on exit
      return toolText(
        `Registered "${agent.id}" with hub ${args.url}.\n` + JSON.stringify(result, null, 2)
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
      return toolText(
        `hub:   ${url}  [${hubOk}]\n` +
          `token: ${mask(token)}\n` +
          `agent: ${myId || "(not set)"}` +
          (cfg.agent ? `\n  role: ${cfg.agent.role || ""}\n  host: ${cfg.agent.host || ""}\n  cwd:  ${cfg.agent.cwd || ""}` : "")
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
      const message = await sendMessage(url, token, {
        from,
        to: args.to,
        body: args.body,
        cwd: cfg.agent?.cwd,
      });
      const resolved = message.requestedTo !== message.to ? ` (resolved from ${message.requestedTo})` : "";
      return toolText(`Sent ${message.id}: ${message.from} -> ${message.to}${resolved}`);
    }

    case "office_inbox": {
      const agent = args.agent || myId;
      if (!agent) return toolText("No inbox owner. Register this session first (office_register).", true);
      const unread = args.unread !== false;
      const messages = await getInbox(url, token, agent, unread);
      let out;
      if (!messages.length) {
        out = `No ${unread ? "unread " : ""}messages for ${agent}.`;
      } else {
        out = messages
          .map((m) => `[${m.id}] ${new Date(m.createdAt).toISOString()} ${m.from} -> ${m.to}\n${m.body}`)
          .join("\n\n");
      }
      if (args.markRead && messages.length) {
        await markRead(url, token, agent, messages.map((m) => m.id));
        out += `\n\n(marked ${messages.length} read)`;
      }
      return toolText(out);
    }

    case "office_unregister": {
      const id = args.agentId || myId;
      if (!id) return toolText("No id to unregister.", true);
      const result = await unregisterAgent(url, token, id);
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
      const result = await callTool(params?.name, params?.arguments || {});
      return reply(id, result);
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
    process.stderr.write(`office-relay-mcp: ${error.stack || error.message}\n`);
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
      process.stderr.write(`office-relay-mcp: bad JSON: ${line}\n`);
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", leaveOffice);
process.on("SIGTERM", leaveOffice);
process.on("SIGINT", leaveOffice);
process.stderr.write(`office-relay-mcp ${SERVER_INFO.version} ready on stdio\n`);
