#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadConfig,
  getInbox,
  waitInbox,
  markRead,
  sendMessage,
  uploadFile,
  downloadFile,
  humanSize,
} from "./client.mjs";

function readOption(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.slice(2).indexOf(`--${name}`);
  if (index >= 0) return process.argv.slice(2)[index + 1] || fallback;
  return fallback;
}

const baseUrl = process.env.OFFICE_URL || "http://127.0.0.1:3977";
const cwd = readOption("cwd") || process.env.OFFICE_AGENT_CWD || process.cwd();
const defaultHost = process.env.OFFICE_AGENT_HOST || process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown-host";

// Remove `--name value` / `--name=value` from args (mutating) and return the value.
function takeOption(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}`) return args.splice(i, 2)[1] || "";
    if (args[i].startsWith(`--${name}=`)) return args.splice(i, 1)[0].slice(name.length + 3);
  }
  return "";
}

// Remove a value-less `--name` flag from args (mutating) and report whether it was there.
function takeFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function sentLine(message) {
  if (message.targetMode === "broadcast") {
    return `sent ${message.id}: ${message.from} -> all (${message.recipients?.length ?? 0} recipient(s))`;
  }
  const resolved = message.requestedTo !== message.to ? ` (resolved from ${message.requestedTo})` : "";
  return `sent ${message.id}: ${message.from} -> ${message.to}${resolved}`;
}

function printMessages(messages) {
  for (const m of messages) {
    const tags = [m.replyTo ? `reply to ${m.replyTo}` : "", m.wake === false ? "fyi" : ""].filter(Boolean);
    console.log(
      `[${m.id}] ${new Date(m.createdAt).toLocaleTimeString()} ${m.from} -> ${m.to}` +
        (tags.length ? ` (${tags.join(", ")})` : "")
    );
    console.log(m.body);
    console.log("");
  }
}

function stripOptions(args) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (!args[i].includes("=") && args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
    } else {
      output.push(args[i]);
    }
  }
  return output;
}

async function api(path, options = {}) {
  const token = process.env.OFFICE_TOKEN || "";
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function usage() {
  console.log(`Usage:
  node mcp/cli.mjs onboard
  node mcp/cli.mjs doctor
  node mcp/cli.mjs register --help
  node mcp/cli.mjs register-template [agent-id] [display-name]
  node mcp/cli.mjs register <agent-id> [display-name]
  node mcp/cli.mjs unregister <agent-id>
  node mcp/cli.mjs heartbeat <agent-id> [status]
  node mcp/cli.mjs sessions
  node mcp/cli.mjs send <from> <to> <message...> [--reply-to <message-id>] [--fyi]
  node mcp/cli.mjs send-dir <from> <directory-query> <message...>
  node mcp/cli.mjs send-file <from> <to> <path> [note...]
  node mcp/cli.mjs fetch <file-id> [save-path]
  node mcp/cli.mjs inbox <agent-id> [--all] [--mark-read]
  node mcp/cli.mjs watch [agent-id] [--once] [--interval 10]
  node mcp/cli.mjs read <agent-id> [message-id...]
  node mcp/cli.mjs state

Examples:
  node mcp/cli.mjs onboard
  node mcp/cli.mjs doctor
  node mcp/cli.mjs register --help
  node mcp/cli.mjs register-template mac-tex-1 "Mac TeX"
  node mcp/cli.mjs register claude-a "Claude A" --role coordinator --host win --capabilities planning,coding
  node mcp/cli.mjs unregister claude-a
  node mcp/cli.mjs sessions
  node mcp/cli.mjs send claude-a claude-b "hello from A"
  node mcp/cli.mjs send-dir claude-a "project-name" "hello to whoever is in that folder"
  node mcp/cli.mjs inbox claude-b --mark-read
`);
}

async function onboard() {
  const health = await api("/api/health");
  console.log(`Agent Intercom Onboarding

Relay:
  ${baseUrl}
  auth: ${health.auth ? "token enabled" : "no token"}

This machine/session:
  host: ${defaultHost}
  cwd:  ${cwd}

If the user asked you to register but did not provide details, ask these short questions:
  1. What agent id should I use? Example: linux-baseline-1, mac-tex-1
  2. What role should I advertise? Example: leader, baseline, literature, tex, reviewer
  3. What host label should I use? Default: ${defaultHost}
  4. What capabilities should I advertise? Example: gpu,experiments,logs
  5. Optional display name?

Then run:
  node mcp/cli.mjs register <agent-id> [display-name] --role <role> --host <host> --capabilities <comma-list>

After registering:
  node mcp/cli.mjs sessions
  node mcp/cli.mjs inbox <agent-id> --mark-read
  node mcp/cli.mjs send <agent-id> <target-agent> "<message>"
`);
}

function registerHelp() {
  console.log(`Register this Claude session with the Agent Intercom hub.

Agent-facing behavior:
  If the user says "register yourself" but does not provide identity details,
  ask short follow-up questions before running register:

  1. What should this session be called? Example: linux-baseline-1, mac-tex-1
  2. What role should it advertise? Example: leader, baseline, literature, tex, reviewer
  3. What host label should it use? Default on this machine: ${defaultHost}
  4. What capabilities should it advertise? Example: gpu,experiments,logs or tex,bibtex,writing
  5. Optional display name. Example: Linux Baseline, Mac TeX

Do not invent a role if the user has a specific organization in mind.
The current working directory is captured automatically:
  ${cwd}

Command shape:
  node mcp/cli.mjs register <agent-id> [display-name] --role <role> --host <host> --capabilities <comma-list>

Examples:
  node mcp/cli.mjs register linux-baseline-1 "Linux Baseline" --role baseline --host linux-gpu --capabilities gpu,experiments,logs
  node mcp/cli.mjs register mac-tex-1 "Mac TeX" --role tex --host macbook --capabilities tex,bibtex,writing

After registering:
  node mcp/cli.mjs sessions
  node mcp/cli.mjs inbox <agent-id> --mark-read
  node mcp/cli.mjs send <agent-id> <target-agent> "<message>"
`);
}

function shellQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function printRegisterTemplate(id = "<agent-id>", name = "<display-name>") {
  const role = readOption("role", "<role>");
  const host = readOption("host", defaultHost);
  const capabilities = readOption("capabilities") || readOption("caps") || "<capability-1,capability-2>";
  console.log(`Current relay: ${baseUrl}`);
  console.log(`Current cwd:   ${cwd}`);
  console.log("");
  console.log("Fill in any placeholders, then run:");
  console.log(`node mcp/cli.mjs register ${id} ${shellQuote(name)} --role ${role} --host ${host} --capabilities ${capabilities}`);
}

const [cmd, ...args] = process.argv.slice(2);

try {
  if (!cmd || cmd === "help") {
    usage();
  } else if (cmd === "onboard") {
    await onboard();
  } else if (cmd === "doctor") {
    const health = await api("/api/health");
    console.log(`relay: ${baseUrl}`);
    console.log(`auth:  ${health.auth ? "token enabled" : "no token"}`);
    console.log(`host:  ${defaultHost}`);
    console.log(`cwd:   ${cwd}`);
  } else if (cmd === "register-template") {
    const cleanArgs = stripOptions(args);
    printRegisterTemplate(cleanArgs[0], cleanArgs.slice(1).join(" ") || undefined);
  } else if (cmd === "register") {
    if (args.includes("--help") || args.includes("-h")) {
      registerHelp();
      process.exit(0);
    }
    const cleanArgs = stripOptions(args);
    const [id, ...nameParts] = cleanArgs;
    if (!id) throw new Error("agent-id is required");
    const agent = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        id,
        name: nameParts.join(" ") || id,
        cwd,
        sessionId: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "",
        backend: "local",
        role: readOption("role"),
        host: readOption("host"),
        capabilities: readOption("capabilities") || readOption("caps"),
      }),
    });
    console.log(JSON.stringify(agent, null, 2));
  } else if (cmd === "unregister" || cmd === "remove") {
    const [id] = args;
    if (!id) throw new Error("agent-id is required");
    const result = await api("/api/unregister", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    console.log(`removed ${result.id}${result.existed ? "" : " (was not registered)"}`);
  } else if (cmd === "heartbeat") {
    const [id, status = "online"] = args;
    if (!id) throw new Error("agent-id is required");
    const agent = await api("/api/heartbeat", {
      method: "POST",
      body: JSON.stringify({ id, status, cwd, backend: "local" }),
    });
    console.log(`${agent.id} ${agent.status}`);
  } else if (cmd === "sessions" || cmd === "list") {
    const state = await api("/api/state");
    const agents = Object.values(state.agents || {}).sort((a, b) => {
      return String(a.cwd || "").localeCompare(String(b.cwd || "")) || a.id.localeCompare(b.id);
    });
    if (agents.length === 0) {
      console.log("No sessions registered.");
    } else {
      for (const agent of agents) {
        console.log(`${agent.id} (${agent.name || agent.id})`);
        console.log(`  status: ${agent.status}`);
        if (agent.role) console.log(`  role:   ${agent.role}`);
        if (agent.host) console.log(`  host:   ${agent.host}`);
        if (agent.capabilities?.length) console.log(`  caps:   ${agent.capabilities.join(", ")}`);
        console.log(`  cwd:    ${agent.cwd || "(unknown)"}`);
        console.log(`  target: ${agent.id}${agent.cwdLabel ? `  or  dir:${agent.cwdLabel}` : ""}`);
      }
    }
  } else if (cmd === "send") {
    const rest = [...args];
    const replyTo = takeOption(rest, "reply-to");
    const fyi = takeFlag(rest, "fyi");
    const [from, to, ...messageParts] = rest;
    if (!from || !to || messageParts.length === 0) throw new Error("from, to, and message are required");
    const message = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        from,
        to,
        body: messageParts.join(" "),
        cwd,
        ...(replyTo ? { replyTo } : {}),
        ...(fyi ? { wake: false } : {}),
      }),
    });
    console.log(sentLine(message));
  } else if (cmd === "send-dir") {
    const [from, dir, ...messageParts] = args;
    if (!from || !dir || messageParts.length === 0) throw new Error("from, directory-query, and message are required");
    const message = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ from, to: `dir:${dir}`, body: messageParts.join(" "), cwd }),
    });
    console.log(`sent ${message.id}: ${message.from} -> ${message.to} (resolved from dir:${dir})`);
  } else if (cmd === "inbox") {
    const agent = args[0];
    if (!agent) throw new Error("agent-id is required");
    const unread = !args.includes("--all");
    const messages = await api(`/api/inbox?agent=${encodeURIComponent(agent)}&unread=${unread}`);
    if (messages.length === 0) {
      console.log(`No ${unread ? "unread " : ""}messages for ${agent}.`);
    } else {
      printMessages(messages);
    }
    if (args.includes("--mark-read") && messages.length > 0) {
      await api("/api/read", {
        method: "POST",
        body: JSON.stringify({ agent, ids: messages.map((m) => m.id) }),
      });
      console.log(`Marked ${messages.length} message(s) read.`);
    }
  } else if (cmd === "send-file") {
    const cleanArgs = stripOptions(args);
    const [from, to, filePath, ...noteParts] = cleanArgs;
    if (!from || !to || !filePath) throw new Error("from, to, and file path are required");
    const cfg = await loadConfig();
    const url = process.env.OFFICE_URL || cfg.url || baseUrl;
    const token = process.env.OFFICE_TOKEN || cfg.token || "";
    const buffer = await readFile(filePath);
    const name = path.basename(filePath);
    const up = await uploadFile(url, token, { name, from, to, buffer });
    const note = noteParts.join(" ");
    const message = await sendMessage(url, token, {
      from,
      to,
      body: `${note ? note + " " : ""}\u{1F4CE} ${name} (${humanSize(up.size)}) — fetch with fileId=${up.id}`,
      file: { id: up.id, name: up.name, size: up.size },
    });
    console.log(`sent file ${name} (${humanSize(up.size)}): ${message.from} -> ${message.to}  fileId=${up.id}`);
  } else if (cmd === "fetch") {
    const cleanArgs = stripOptions(args);
    const [fileId, savePathArg] = cleanArgs;
    if (!fileId) throw new Error("fileId is required");
    const cfg = await loadConfig();
    const url = process.env.OFFICE_URL || cfg.url || baseUrl;
    const token = process.env.OFFICE_TOKEN || cfg.token || "";
    const dl = await downloadFile(url, token, fileId);
    const savePath = savePathArg || path.join(process.cwd(), dl.name || fileId);
    await writeFile(savePath, dl.buffer);
    console.log(`saved ${humanSize(dl.size)} to ${savePath}`);
  } else if (cmd === "watch") {
    // Inbox monitor, the fallback for sessions without push delivery (see
    // docs/delivery-design.md). It long-polls the hub and, once wake-worthy mail
    // arrives, prints everything unread, marks it read, and EXITS — in Claude Code
    // a backgrounded command exiting re-invokes the agent. FYI (wake:false)
    // messages never end the watch on their own; they ride along with the next
    // wake-worthy one. Hubs without /api/inbox/wait are polled every --interval s.
    const cfg = await loadConfig();
    const id = stripOptions(args)[0] || cfg.agent?.id;
    if (!id) throw new Error("agent-id required (or register first so it is saved)");
    const url = process.env.OFFICE_URL || cfg.url || baseUrl;
    const token = process.env.OFFICE_TOKEN || cfg.token || "";
    const intervalMs = Math.max(2, Number(readOption("interval")) || 10) * 1000;
    const once = args.includes("--once");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let legacy = false;
    let messages = [];
    for (;;) {
      try {
        if (once || legacy) {
          messages = await getInbox(url, token, id, true);
          if (!once && !messages.some((m) => m.wake !== false)) messages = [];
        } else {
          messages = await waitInbox(url, token, id, { wakeOnly: true });
        }
      } catch (error) {
        if (error.status === 404 && !legacy) {
          legacy = true;
          continue;
        }
        console.error(`office: ${error.message}`);
        messages = [];
        await sleep(intervalMs);
        continue;
      }
      if (messages.length || once) break;
      if (legacy) await sleep(intervalMs);
    }
    if (!messages.length) {
      console.log(`No new messages for ${id}.`);
    } else {
      console.log(`\u{1F4EC} ${messages.length} new message(s) for ${id}:`);
      printMessages(messages);
      await markRead(url, token, id, messages.map((m) => m.id)).catch(() => {});
    }
  } else if (cmd === "read") {
    const [agent, ...ids] = args;
    if (!agent) throw new Error("agent-id is required");
    await api("/api/read", {
      method: "POST",
      body: JSON.stringify({ agent, ids }),
    });
    console.log("ok");
  } else if (cmd === "state") {
    console.log(JSON.stringify(await api("/api/state"), null, 2));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} catch (error) {
  console.error(`office: ${error.message}`);
  process.exit(1);
}
