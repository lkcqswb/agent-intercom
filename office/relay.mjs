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
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(JSON.stringify(value));
}

function html(res, value) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
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

  if ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/unregister") {
    const data = req.method === "DELETE"
      ? { id: url.searchParams.get("id") }
      : await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    const existed = Boolean(state.agents[data.id]);
    delete state.agents[data.id];
    addEvent(state, "unregister", { agent: data.id, existed });
    await saveState(state);
    return json(res, 200, { ok: true, id: data.id, existed });
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

function page() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Office Relay</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111; color: #eee; }
    body { margin: 0; padding: 24px; }
    main { max-width: 1080px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .muted { color: #aaa; font-size: 13px; }
    .toolbar { display: flex; gap: 8px; margin: 18px 0; align-items: center; }
    input { border: 1px solid #444; background: #0f172a; color: #fff; padding: 7px 10px; border-radius: 6px; min-width: 240px; }
    button { border: 1px solid #444; background: #1f2937; color: #fff; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
    button:hover { background: #374151; }
    button.danger { border-color: #7f1d1d; background: #450a0a; }
    table { width: 100%; border-collapse: collapse; background: #181818; border: 1px solid #333; }
    th, td { border-bottom: 1px solid #2b2b2b; padding: 10px; text-align: left; vertical-align: top; font-size: 14px; }
    th { color: #bbb; font-weight: 600; background: #202020; }
    code { color: #d8b4fe; }
    .empty { padding: 24px; border: 1px solid #333; background: #181818; }
  </style>
</head>
<body>
<main>
  <h1>Office Relay</h1>
  <div class="muted">Registered sessions only. Use pixtuoid for the visual office.</div>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <input id="token" type="password" placeholder="Bearer token, if required">
    <button id="saveToken">Save token</button>
    <span class="muted" id="status"></span>
  </div>
  <div id="app"></div>
</main>
<script>
const app = document.querySelector("#app");
const statusEl = document.querySelector("#status");
const tokenInput = document.querySelector("#token");
tokenInput.value = localStorage.getItem("officeRelayToken") || "";
document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#saveToken").addEventListener("click", () => {
  localStorage.setItem("officeRelayToken", tokenInput.value.trim());
  load();
});

function headers() {
  const token = localStorage.getItem("officeRelayToken") || "";
  return token ? { authorization: "Bearer " + token } : {};
}

function age(ts) {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  return Math.floor(minutes / 60) + "h ago";
}

async function clearAgent(id) {
  if (!confirm("Remove " + id + " from Office Relay?")) return;
  const res = await fetch("/api/unregister", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers() },
    body: JSON.stringify({ id })
  });
  if (!res.ok) alert(await res.text());
  await load();
}

async function load() {
  statusEl.textContent = "Loading...";
  const res = await fetch("/api/state", { headers: headers() });
  if (!res.ok) {
    statusEl.textContent = "Unable to load sessions";
    app.innerHTML = '<div class="empty">Request failed: ' + escapeHtml(await res.text()) + '</div>';
    return;
  }
  const state = await res.json();
  const agents = Object.values(state.agents || {}).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  statusEl.textContent = agents.length + " registered session" + (agents.length === 1 ? "" : "s");
  if (!agents.length) {
    app.innerHTML = '<div class="empty">No registered sessions.</div>';
    return;
  }
  app.innerHTML = '<table><thead><tr><th>Agent</th><th>Status</th><th>Role</th><th>Host</th><th>Directory</th><th>Last seen</th><th></th></tr></thead><tbody>' +
    agents.map(agent => '<tr>' +
      '<td><strong>' + escapeHtml(agent.name || agent.id) + '</strong><br><code>' + escapeHtml(agent.id) + '</code></td>' +
      '<td>' + escapeHtml(agent.status || "") + '</td>' +
      '<td>' + escapeHtml(agent.role || "") + '<br><span class="muted">' + escapeHtml((agent.capabilities || []).join(", ")) + '</span></td>' +
      '<td>' + escapeHtml(agent.host || "") + '</td>' +
      '<td><code>' + escapeHtml(agent.cwd || "") + '</code></td>' +
      '<td>' + age(agent.lastSeen) + '</td>' +
      '<td><button class="danger" data-id="' + escapeHtml(agent.id) + '">Remove</button></td>' +
    '</tr>').join("") + '</tbody></table>';
  for (const button of app.querySelectorAll("button[data-id]")) {
    button.addEventListener("click", () => clearAgent(button.dataset.id));
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/") return html(res, page());
    return json(res, 404, { error: "not found" });
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
