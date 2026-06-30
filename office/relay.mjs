#!/usr/bin/env node

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(__dirname, "office-state.json");
const port = Number(process.env.OFFICE_PORT || 3977);
const host = process.env.OFFICE_HOST || "127.0.0.1";
const token = process.env.OFFICE_TOKEN || "";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage:
  office-relay

Environment:
  OFFICE_HOST   Host to bind. Default: 127.0.0.1
  OFFICE_PORT   Port to bind. Default: 3977
  OFFICE_TOKEN  Optional bearer token required by API clients

Examples:
  npm run office
  OFFICE_HOST=0.0.0.0 OFFICE_PORT=3977 OFFICE_TOKEN=secret npm run office
`);
  process.exit(0);
}

const defaultState = {
  agents: {},
  messages: [],
  events: [],
};

async function loadState() {
  if (!existsSync(statePath)) return structuredClone(defaultState);
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(await readFile(statePath, "utf8")) };
  } catch {
    return structuredClone(defaultState);
  }
}

async function saveState(state) {
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function addEvent(state, type, payload) {
  state.events.push({ id: crypto.randomUUID(), type, payload, at: Date.now() });
  state.events = state.events.slice(-200);
}

function parseList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cwdLabel(cwd) {
  if (!cwd) return "";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
}

function placeAgent(state, id, name, details = {}) {
  const existing = state.agents[id] || {};
  const count = Object.keys(state.agents).length;
  const cwd = details.cwd || existing.cwd || "";
  return {
    id,
    name: name || existing.name || id,
    status: "online",
    lastSeen: Date.now(),
    x: existing.x ?? 120 + (count % 4) * 170,
    y: existing.y ?? 150 + Math.floor(count / 4) * 130,
    color: existing.color ?? ["#38bdf8", "#f97316", "#84cc16", "#f43f5e", "#a78bfa"][count % 5],
    cwd,
    cwdLabel: cwdLabel(cwd),
    sessionId: details.sessionId || existing.sessionId || "",
    backend: details.backend || existing.backend || "local",
    role: details.role || existing.role || "",
    host: details.host || existing.host || "",
    capabilities: parseList(details.capabilities || existing.capabilities),
    registeredAt: existing.registeredAt || Date.now(),
  };
}

function resolveTarget(state, to, from) {
  if (state.agents[to]) return { id: to, mode: "agent" };

  const raw = String(to || "");
  const isDirectoryTarget = raw.startsWith("dir:") || raw.startsWith("cwd:");
  if (!isDirectoryTarget) return { id: to, mode: "literal" };

  const query = raw.slice(raw.indexOf(":") + 1).toLowerCase();
  const candidates = Object.values(state.agents)
    .filter((agent) => {
      const cwd = String(agent.cwd || "").toLowerCase();
      const label = String(agent.cwdLabel || "").toLowerCase();
      return cwd === query || cwd.includes(query) || label === query || label.includes(query);
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const preferred = candidates.find((agent) => agent.id !== from) || candidates[0];
  return preferred
    ? { id: preferred.id, mode: "directory", matched: preferred }
    : { id: to, mode: "unresolved-directory" };
}

async function handleApi(req, res, url) {
  if (token) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
  }

  const state = await loadState();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, mode: "office-relay", auth: Boolean(token) });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    for (const agent of Object.values(state.agents)) {
      if (Date.now() - agent.lastSeen > 45000) agent.status = "idle";
    }
    await saveState(state);
    return json(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const data = await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    state.agents[data.id] = placeAgent(state, data.id, data.name, {
      cwd: data.cwd,
      sessionId: data.sessionId,
      backend: data.backend,
      role: data.role,
      host: data.host,
      capabilities: data.capabilities,
    });
    addEvent(state, "register", { agent: data.id });
    await saveState(state);
    return json(res, 200, state.agents[data.id]);
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    const data = await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    state.agents[data.id] = placeAgent(state, data.id, data.name, {
      cwd: data.cwd,
      sessionId: data.sessionId,
      backend: data.backend,
      role: data.role,
      host: data.host,
      capabilities: data.capabilities,
    });
    state.agents[data.id].status = data.status || "online";
    state.agents[data.id].lastSeen = Date.now();
    await saveState(state);
    return json(res, 200, state.agents[data.id]);
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const data = await body(req);
    if (!data.from || !data.to || !data.body) {
      return json(res, 400, { error: "from, to, and body are required" });
    }
    state.agents[data.from] = placeAgent(state, data.from, undefined, { cwd: data.cwd });
    const target = resolveTarget(state, data.to, data.from);
    const message = {
      id: crypto.randomUUID().slice(0, 8),
      from: data.from,
      to: target.id,
      requestedTo: data.to,
      targetMode: target.mode,
      body: data.body,
      status: "queued",
      createdAt: Date.now(),
      readAt: null,
      replyTo: data.replyTo || null,
    };
    state.messages.push(message);
    addEvent(state, "message", { id: message.id, from: data.from, to: data.to });
    await saveState(state);
    return json(res, 200, message);
  }

  if (req.method === "GET" && url.pathname === "/api/inbox") {
    const agent = url.searchParams.get("agent");
    const unreadOnly = url.searchParams.get("unread") !== "false";
    if (!agent) return json(res, 400, { error: "agent is required" });
    const messages = state.messages.filter((m) => {
      const addressed = m.to === agent || m.to === "all";
      return addressed && (!unreadOnly || !m.readAt);
    });
    return json(res, 200, messages);
  }

  if (req.method === "POST" && url.pathname === "/api/read") {
    const data = await body(req);
    const agent = data.agent;
    const ids = new Set(data.ids || []);
    for (const message of state.messages) {
      if ((message.to === agent || message.to === "all") && (ids.size === 0 || ids.has(message.id))) {
        message.status = "read";
        message.readAt = message.readAt || Date.now();
      }
    }
    await saveState(state);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return json(res, 200, {
      name: "claude-office-relay",
      ok: true,
      api: ["/api/health", "/api/state", "/api/register", "/api/send", "/api/inbox"],
    });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Claude Office Relay running at http://${host}:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`office-relay: ${host}:${port} is already in use`);
    process.exit(1);
  }
  throw error;
});
