#!/usr/bin/env node

import http from "node:http";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = process.env.OFFICE_STATE_PATH || path.join(__dirname, "office-state.json");
const filesDir = process.env.OFFICE_FILES_PATH || path.join(path.dirname(statePath), "files");
const port = Number(process.env.OFFICE_PORT || 3977);
const host = process.env.OFFICE_HOST || "127.0.0.1";
const token = process.env.OFFICE_TOKEN || "";
const viewToken = process.env.OFFICE_VIEW_TOKEN || ""; // read-only: office UI / shareable preview

// Tunables (env-overridable)
const idleMs = Number(process.env.OFFICE_IDLE_MS || 45000);
const offlineMs = Number(process.env.OFFICE_OFFLINE_MS || 180000);
const agentTtlMs = Number(process.env.OFFICE_AGENT_TTL_MS || 86400000); // prune agents unseen 24h
const messageTtlMs = Number(process.env.OFFICE_MESSAGE_TTL_MS || 86400000); // drop read msgs after 24h
const unreadTtlMs = Number(process.env.OFFICE_UNREAD_TTL_MS || 604800000); // drop unread msgs after 7d
const messagesMax = Number(process.env.OFFICE_MESSAGES_MAX || 5000);
const maxBody = Number(process.env.OFFICE_MAX_BODY || 65536); // 64 KiB
const maxFile = Number(process.env.OFFICE_MAX_FILE || 104857600); // 100 MiB
const fileTtlMs = Number(process.env.OFFICE_FILE_TTL_MS || 86400000); // drop files after 24h
const rateLimit = Number(process.env.OFFICE_RATE_LIMIT || 240); // requests/min/IP
const trustProxy = process.env.OFFICE_TRUST_PROXY === "1";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage:
  agent-intercom

Environment:
  OFFICE_HOST        Host to bind. Default: 127.0.0.1
  OFFICE_PORT        Port to bind. Default: 3977
  OFFICE_TOKEN       Bearer token. REQUIRED when binding a non-loopback host
                     (unless OFFICE_ALLOW_NO_TOKEN=1).
  OFFICE_VIEW_TOKEN  Optional read-only token for the office UI / shareable
                     preview link. Can GET /api/feed and /api/state only.
  OFFICE_STATE_PATH  Where to persist state. Default: alongside this file.
  OFFICE_RATE_LIMIT  Max API requests per minute per client IP. Default: 240
  OFFICE_MAX_BODY    Max request body bytes. Default: 65536
  OFFICE_MAX_FILE    Max upload file bytes. Default: 104857600 (100 MiB)
  OFFICE_FILES_PATH  Where uploaded files are stored. Default: <state dir>/files
  OFFICE_TRUST_PROXY Set to 1 to read client IP from X-Forwarded-For.

Examples:
  npm run office
  OFFICE_HOST=0.0.0.0 OFFICE_PORT=3977 OFFICE_TOKEN=secret npm run office
`);
  process.exit(0);
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const isLoopback = loopbackHosts.has(host);
if (!token && !isLoopback && process.env.OFFICE_ALLOW_NO_TOKEN !== "1") {
  console.error(
    `agent-intercom: refusing to bind public host "${host}" without a token.\n` +
      `Set OFFICE_TOKEN=<secret> (recommended) or OFFICE_ALLOW_NO_TOKEN=1 to override.`
  );
  process.exit(1);
}

const tokenHeader = token ? `Bearer ${token}` : "";
const viewHeader = viewToken ? `Bearer ${viewToken}` : "";

// ---------------------------------------------------------------------------
// State: single in-memory source of truth. All mutations happen synchronously
// inside request handlers (Node is single-threaded, so there is no read/modify/
// write interleaving), and are persisted via an atomic, serialized writer.
// ---------------------------------------------------------------------------
const defaultState = { agents: {}, messages: [], events: [], files: {} };

// Load once at startup (async, before listen).
let state = structuredClone(defaultState);
async function initState() {
  if (!existsSync(statePath)) return;
  try {
    state = { ...structuredClone(defaultState), ...JSON.parse(await readFile(statePath, "utf8")) };
  } catch {
    console.error(`agent-intercom: could not parse ${statePath}, starting fresh`);
  }
}

let dirty = false;
let writing = false;
async function flush() {
  if (writing) return;
  writing = true;
  try {
    while (dirty) {
      dirty = false;
      const tmp = `${statePath}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, statePath); // atomic on same filesystem
    }
  } catch (error) {
    console.error("agent-intercom: persist failed:", error.message);
  } finally {
    writing = false;
  }
}
function persist() {
  dirty = true;
  flush();
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
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      const error = new Error("payload too large");
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function addEvent(type, payload) {
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

function placeAgent(id, name, details = {}) {
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
    capabilities: parseList(details.capabilities ?? existing.capabilities),
    registeredAt: existing.registeredAt || Date.now(),
  };
}

function touch(id) {
  const agent = state.agents[id];
  if (agent) {
    agent.lastSeen = Date.now();
    agent.status = "online";
  }
}

function resolveTarget(to, from) {
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

// Recompute liveness + prune stale agents/messages. Returns true if state changed.
function reconcile() {
  const now = Date.now();
  let changed = false;
  for (const [id, agent] of Object.entries(state.agents)) {
    const age = now - (agent.lastSeen || 0);
    if (age > agentTtlMs) {
      delete state.agents[id];
      changed = true;
      continue;
    }
    const status = age > offlineMs ? "offline" : age > idleMs ? "idle" : "online";
    if (status !== agent.status) {
      agent.status = status;
      changed = true;
    }
  }
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => {
    if (m.readAt) return now - m.readAt < messageTtlMs;
    return now - (m.createdAt || 0) < unreadTtlMs;
  });
  if (state.messages.length > messagesMax) {
    state.messages = state.messages.slice(-messagesMax);
  }
  if (state.messages.length !== before) changed = true;
  for (const [id, f] of Object.entries(state.files || {})) {
    if (now - (f.createdAt || 0) > fileTtlMs) {
      delete state.files[id];
      unlink(path.join(filesDir, id)).catch(() => {});
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window per client IP)
// ---------------------------------------------------------------------------
const buckets = new Map();
function clientIp(req) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}
function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > rateLimit;
}

function safeMatch(provided, expected) {
  if (!expected) return false;
  const p = Buffer.from(String(provided || ""));
  const e = Buffer.from(expected);
  if (p.length !== e.length) return false;
  return crypto.timingSafeEqual(p, e);
}

// "full" = can mutate; "view" = read-only (office UI); "none" = rejected.
function authLevel(req) {
  if (!token) return "full"; // no auth configured (local dev)
  const header = req.headers.authorization || "";
  if (safeMatch(header, tokenHeader)) return "full";
  if (viewToken && safeMatch(header, viewHeader)) return "view";
  return "none";
}

async function handleApi(req, res, url) {
  // Health is intentionally unauthenticated so containers/clients can probe it.
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, mode: "agent-intercom", auth: Boolean(token) });
  }

  if (rateLimited(req)) return json(res, 429, { error: "rate limit exceeded" });

  const level = authLevel(req);
  if (level === "none") return json(res, 401, { error: "unauthorized" });
  const isReadOnlyPath =
    req.method === "GET" && (url.pathname === "/api/state" || url.pathname === "/api/feed");
  if (level === "view" && !isReadOnlyPath) {
    return json(res, 403, { error: "read-only token" });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    // Liveness/cleanup, but never expose message bodies here.
    if (reconcile()) persist();
    return json(res, 200, { ok: true, agents: state.agents, events: state.events });
  }

  if (req.method === "GET" && url.pathname === "/api/feed") {
    // Powers the office UI: presence + recent message stream. Read-only.
    if (reconcile()) persist();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 120, 1), 500);
    return json(res, 200, {
      ok: true,
      now: Date.now(),
      youAre: level,
      agents: state.agents,
      messages: state.messages.slice(-limit),
      events: state.events.slice(-60),
    });
  }

  // ---- File transfer (blob store on the hub) ----
  if (req.method === "POST" && url.pathname === "/api/file") {
    const name = (url.searchParams.get("name") || "file").slice(0, 255);
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await mkdir(filesDir, { recursive: true });
    const dest = path.join(filesDir, id);
    const tmp = dest + ".part";
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxFile) return cb(new Error("FILE_TOO_LARGE"));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmp));
    } catch (error) {
      await unlink(tmp).catch(() => {});
      if (error.message === "FILE_TOO_LARGE") return json(res, 413, { error: "file too large" });
      throw error;
    }
    await rename(tmp, dest);
    state.files[id] = { id, name, size, from, to, createdAt: Date.now() };
    addEvent("file", { id, name, size, from, to });
    persist();
    return json(res, 200, { id, name, size });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/file/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/file/".length));
    if (!/^[a-f0-9]{6,40}$/i.test(id)) return json(res, 400, { error: "bad file id" });
    const meta = state.files[id];
    const p = path.join(filesDir, id);
    if (!meta || !existsSync(p)) return json(res, 404, { error: "file not found" });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(meta.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "access-control-allow-origin": "*",
    });
    return void createReadStream(p).pipe(res);
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const data = await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    state.agents[data.id] = placeAgent(data.id, data.name, {
      cwd: data.cwd,
      sessionId: data.sessionId,
      backend: data.backend,
      role: data.role,
      host: data.host,
      capabilities: data.capabilities,
    });
    addEvent("register", { agent: data.id });
    persist();
    return json(res, 200, state.agents[data.id]);
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    const data = await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    state.agents[data.id] = placeAgent(data.id, data.name, {
      cwd: data.cwd,
      sessionId: data.sessionId,
      backend: data.backend,
      role: data.role,
      host: data.host,
      capabilities: data.capabilities,
    });
    state.agents[data.id].status = data.status || "online";
    state.agents[data.id].lastSeen = Date.now();
    persist();
    return json(res, 200, state.agents[data.id]);
  }

  if ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/unregister") {
    const data = req.method === "DELETE" ? { id: url.searchParams.get("id") } : await body(req);
    if (!data.id) return json(res, 400, { error: "id is required" });
    const existed = Boolean(state.agents[data.id]);
    delete state.agents[data.id];
    addEvent("unregister", { agent: data.id, existed });
    persist();
    return json(res, 200, { ok: true, id: data.id, existed });
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const data = await body(req);
    if (!data.from || !data.to || !data.body) {
      return json(res, 400, { error: "from, to, and body are required" });
    }
    if (String(data.body).length > maxBody) {
      return json(res, 413, { error: "message body too large" });
    }
    if (!state.agents[data.from]) {
      state.agents[data.from] = placeAgent(data.from, undefined, { cwd: data.cwd });
    } else {
      touch(data.from);
    }
    const target = resolveTarget(data.to, data.from);
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
      file: data.file || null,
    };
    state.messages.push(message);
    if (state.messages.length > messagesMax) state.messages = state.messages.slice(-messagesMax);
    addEvent("message", { id: message.id, from: data.from, to: target.id });
    persist();
    return json(res, 200, message);
  }

  if (req.method === "GET" && url.pathname === "/api/inbox") {
    const agent = url.searchParams.get("agent");
    const unreadOnly = url.searchParams.get("unread") !== "false";
    if (!agent) return json(res, 400, { error: "agent is required" });
    touch(agent);
    const messages = state.messages.filter((m) => {
      const addressed = m.to === agent || m.to === "all";
      return addressed && (!unreadOnly || !m.readAt);
    });
    return json(res, 200, messages);
  }

  if (req.method === "POST" && url.pathname === "/api/read") {
    const data = await body(req);
    const agent = data.agent;
    if (!agent) return json(res, 400, { error: "agent is required" });
    const ids = new Set(data.ids || []);
    touch(agent);
    for (const message of state.messages) {
      if ((message.to === agent || message.to === "all") && (ids.size === 0 || ids.has(message.id))) {
        message.status = "read";
        message.readAt = message.readAt || Date.now();
      }
    }
    persist();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
}

function page() {
  // Self-contained pixel-office UI (original CSS-drawn art, no third-party assets).
  // Read-only: polls /api/feed for presence + the message stream. Token comes from
  // the URL (#token=… preferred, ?token=… also accepted) or localStorage.
  // NOTE: the inline script must avoid backticks and ${ } (it lives in a template literal).
  return [
"<!doctype html>",
"<html lang='en'><head>",
"<meta charset='utf-8'>",
"<meta name='viewport' content='width=device-width, initial-scale=1'>",
"<title>Agent Intercom</title>",
"<style>",
":root{color-scheme:dark;--bg:#0d1018;--panel:#141a26;--line:#243049;--ink:#e7ecf5;--mut:#8a97b0;--accent:#54b6ff}",
"*{box-sizing:border-box}",
"body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px}",
"#top{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--line);background:#0a0d14;position:sticky;top:0;z-index:5}",
".brand{font-weight:700;font-size:16px;letter-spacing:.5px}",
".brand .sub{color:var(--mut);font-weight:400;font-size:12px;margin-left:6px}",
".meta{margin-left:auto;display:flex;gap:10px;align-items:center;color:var(--mut)}",
".badge{border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px}",
".badge.full{color:#ffd479;border-color:#5a4a1f}.badge.view{color:#7fd1a8;border-color:#234e3a}",
".keybox{display:flex;gap:6px}.keybox input{background:#0f1623;border:1px solid var(--line);color:#fff;border-radius:6px;padding:5px 8px;width:200px}",
".keybox button,.mini{background:#1c2740;border:1px solid var(--line);color:#fff;border-radius:6px;padding:5px 9px;cursor:pointer}",
"#stage{display:flex;height:calc(100vh - 49px)}",
"#floor{position:relative;flex:1;overflow:hidden;background:",
"repeating-linear-gradient(45deg,#11161f 0 14px,#0f141d 14px 28px);",
"border-right:1px solid var(--line)}",
"#floor:before{content:'';position:absolute;inset:14px;border:2px dashed #1c2740;border-radius:10px;pointer-events:none}",
".empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--mut)}",
".seat{position:absolute;width:120px;margin-left:-60px;text-align:center;transition:left .6s ease,top .6s ease,opacity .4s;cursor:default}",
".seat.enter{animation:pop .45s ease}",
".seat.leaving{opacity:0;transform:scale(.7)}",
"@keyframes pop{0%{opacity:0;transform:translateY(-10px) scale(.6)}100%{opacity:1;transform:none}}",
".person{position:relative;width:40px;height:46px;margin:0 auto}",
".person .head{position:absolute;left:11px;top:0;width:18px;height:18px;background:var(--c);border:2px solid #0a0d14;border-radius:6px}",
".person .head:after{content:'';position:absolute;left:3px;top:7px;width:3px;height:3px;background:#0a0d14;box-shadow:7px 0 0 #0a0d14}",
".person .body{position:absolute;left:6px;top:17px;width:28px;height:26px;background:var(--c);border:2px solid #0a0d14;border-radius:8px 8px 4px 4px;filter:brightness(.85)}",
".desk{width:78px;height:12px;margin:2px auto 0;background:#3a2c1e;border:2px solid #0a0d14;border-radius:3px;box-shadow:0 6px 0 -2px #00000055}",
".idle .person{filter:grayscale(.5) brightness(.7)}",
".label{margin-top:6px;font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
".role{color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
".dot{display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:middle;margin-right:3px}",
".s-online{background:#41d97f;box-shadow:0 0 6px #41d97f}.s-idle{background:#e6b450}.s-offline{background:#6b7280}",
".bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:6px;max-width:170px;background:#fff;color:#111;border-radius:8px;padding:5px 8px;font-size:11px;line-height:1.3;box-shadow:0 4px 14px #0008;opacity:0;transition:opacity .25s;pointer-events:none;white-space:normal;z-index:3}",
".bubble.show{opacity:1}.bubble:after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#fff}",
".pulse{position:absolute;width:46px;height:46px;margin:-3px 0 0 -3px;border:2px solid var(--accent);border-radius:10px;animation:pr .8s ease-out forwards;pointer-events:none}",
"@keyframes pr{0%{opacity:.8;transform:scale(.7)}100%{opacity:0;transform:scale(2.2)}}",
".fly{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent);transition:transform 1s cubic-bezier(.4,0,.2,1),opacity 1s;z-index:4;pointer-events:none}",
"#side{width:340px;display:flex;flex-direction:column;background:var(--panel)}",
".side-h{padding:10px 14px;border-bottom:1px solid var(--line);font-weight:700}",
"#feed{flex:1;overflow:auto;padding:8px 10px}",
".msg{border:1px solid var(--line);border-radius:8px;padding:7px 9px;margin-bottom:7px;background:#0f1623;animation:pop .3s ease}",
".msg .rt{display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px}",
".msg .who{font-weight:700}.msg .arrow{color:var(--mut)}.msg .t{color:var(--mut)}",
".msg .bd{white-space:pre-wrap;word-break:break-word}",
".msg.broadcast{border-color:#5a4a1f}",
"</style></head><body>",
"<div id='top'>",
"<div class='brand'>&#127970; Agent Intercom<span class='sub'>live office</span></div>",
"<div class='meta'><span id='count'>connecting&hellip;</span><span id='mode' class='badge'></span>",
"<span id='keybox' class='keybox' hidden><input id='key' type='password' placeholder='view token'><button id='save'>enter</button></span>",
"</div></div>",
"<div id='stage'>",
"<div id='floor'><div id='floorEmpty' class='empty'>waiting for the relay&hellip;</div></div>",
"<aside id='side'><div class='side-h'>&#128172; Activity</div><div id='feed'></div></aside>",
"</div>",
"<script>",
"var qs=new URLSearchParams(location.search);",
"var hs=new URLSearchParams((location.hash||'').replace(/^#/,''));",
"var token=qs.get('token')||hs.get('token')||localStorage.getItem('officeRelayToken')||'';",
"if(token)localStorage.setItem('officeRelayToken',token);",
"var floor=document.getElementById('floor'),feed=document.getElementById('feed');",
"var countEl=document.getElementById('count'),modeEl=document.getElementById('mode');",
"var keybox=document.getElementById('keybox');",
"document.getElementById('save').onclick=function(){var v=document.getElementById('key').value.trim();if(v){localStorage.setItem('officeRelayToken',v);token=v;keybox.hidden=true;poll();}};",
"var seats={},seenMsgs=null,canRemove=false;",
"function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'})[c];});}",
"function ago(ts){if(!ts)return '';var s=Math.max(0,Math.floor((Date.now()-ts)/1000));if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m';return Math.floor(m/60)+'h';}",
"function hdr(){return token?{authorization:'Bearer '+token}:{};}",
"function present(a){return a.status==='online'||a.status==='idle';}",
"function layout(ids){var n=ids.length;var cols=Math.max(1,Math.min(5,Math.ceil(Math.sqrt(n))));var rows=Math.ceil(n/cols);ids.forEach(function(id,i){var seat=seats[id];if(!seat)return;var r=Math.floor(i/cols),c=i%cols;var cellW=100/cols,cellH=100/Math.max(1,rows);var left=cellW*(c+0.5),top=cellH*(r+0.5);seat.el.style.left=left+'%';seat.el.style.top='calc('+top+'% + 6px)';});}",
"function makeSeat(a){var el=document.createElement('div');el.className='seat enter';el.innerHTML=",
"'<div class=\"bubble\"></div>'+",
"'<div class=\"person\" style=\"--c:'+esc(a.color||'#54b6ff')+'\"><div class=\"head\"></div><div class=\"body\"></div></div>'+",
"'<div class=\"desk\"></div>'+",
"'<div class=\"label\"><span class=\"dot\"></span><span class=\"nm\"></span></div>'+",
"'<div class=\"role\"></div>';",
"floor.appendChild(el);setTimeout(function(){el.classList.remove('enter');},460);",
"return {el:el,bubble:el.querySelector('.bubble'),dot:el.querySelector('.dot'),nm:el.querySelector('.nm'),role:el.querySelector('.role')};}",
"function updateSeat(s,a){s.dot.className='dot s-'+(a.status||'offline');s.nm.textContent=a.name||a.id;var caps=(a.capabilities&&a.capabilities.length)?(' \\u00b7 '+a.capabilities.join(',')):'';s.role.textContent=(a.role||'')+(a.host?(' @'+a.host):'')+caps;s.el.title=a.id+'  '+(a.cwd||'')+'  ('+a.status+', seen '+ago(a.lastSeen)+')';s.el.classList.toggle('idle',a.status==='idle');}",
"function center(id){var s=seats[id];if(!s)return null;var p=s.el.querySelector('.person');var fr=floor.getBoundingClientRect(),pr=p.getBoundingClientRect();return {x:pr.left-fr.left+pr.width/2,y:pr.top-fr.top+pr.height/2};}",
"function showBubble(id,text){var s=seats[id];if(!s)return;s.bubble.textContent=text.length>90?text.slice(0,88)+'\\u2026':text;s.bubble.classList.add('show');clearTimeout(s.bt);s.bt=setTimeout(function(){s.bubble.classList.remove('show');},4200);}",
"function pulse(id){var c=center(id);if(!c)return;var d=document.createElement('div');d.className='pulse';d.style.left=c.x+'px';d.style.top=c.y+'px';floor.appendChild(d);setTimeout(function(){d.remove();},850);}",
"function fly(from,to){var a=center(from),b=center(to);if(!a||!b)return;var d=document.createElement('div');d.className='fly';d.style.left=a.x+'px';d.style.top=a.y+'px';floor.appendChild(d);requestAnimationFrame(function(){d.style.transform='translate('+(b.x-a.x)+'px,'+(b.y-a.y)+'px)';setTimeout(function(){d.style.opacity='0';},650);});setTimeout(function(){d.remove();},1100);}",
"function animateMsg(m){showBubble(m.from,m.body);if(m.to==='all'){pulse(m.from);Object.keys(seats).forEach(function(id){if(id!==m.from)fly(m.from,id);});}else{fly(m.from,m.to);}}",
"function addMsg(m,animate){if(seenMsgs[m.id])return;seenMsgs[m.id]=1;var div=document.createElement('div');div.className='msg'+(m.to==='all'?' broadcast':'');div.innerHTML='<div class=\"rt\"><span><span class=\"who\">'+esc(m.from)+'</span> <span class=\"arrow\">&rarr;</span> <span class=\"who\">'+esc(m.to)+'</span></span><span class=\"t\" data-ts=\"'+(m.createdAt||0)+'\">'+ago(m.createdAt)+'</span></div><div class=\"bd\">'+esc(m.body)+'</div>';feed.insertBefore(div,feed.firstChild);while(feed.children.length>80)feed.removeChild(feed.lastChild);if(animate)animateMsg(m);}",
"function refreshTimes(){var ts=feed.querySelectorAll('.t');for(var i=0;i<ts.length;i++){ts[i].textContent=ago(Number(ts[i].getAttribute('data-ts')));}}",
"function render(data){canRemove=(data.youAre==='full');modeEl.textContent=canRemove?'admin':'read-only';modeEl.className='badge '+(canRemove?'full':'view');",
"var agents=data.agents||{};var ids=Object.keys(agents).filter(function(id){return present(agents[id]);});",
"ids.sort(function(a,b){return (agents[a].registeredAt||0)-(agents[b].registeredAt||0)||a.localeCompare(b);});",
"Object.keys(seats).forEach(function(id){if(ids.indexOf(id)<0){var s=seats[id];s.el.classList.add('leaving');setTimeout(function(){if(s.el.parentNode)s.el.remove();},420);delete seats[id];}});",
"ids.forEach(function(id){if(!seats[id])seats[id]=makeSeat(agents[id]);updateSeat(seats[id],agents[id]);});",
"layout(ids);",
"var fe=document.getElementById('floorEmpty');fe.textContent='Office is empty - no sessions connected yet';fe.style.display=ids.length?'none':'flex';",
"countEl.textContent=ids.length+' in office'+(ids.length?(' \\u00b7 '+ids.filter(function(id){return agents[id].status==='online';}).length+' active'):'');",
"var msgs=data.messages||[];var firstLoad=(seenMsgs===null);if(firstLoad)seenMsgs={};msgs.forEach(function(m){addMsg(m,!firstLoad);});refreshTimes();}",
"function poll(){fetch('/api/feed?limit=120',{headers:hdr()}).then(function(r){if(r.status===401){countEl.textContent='token required';keybox.hidden=false;throw 0;}if(!r.ok)throw 0;return r.json();}).then(render).catch(function(){});}",
"poll();setInterval(poll,1500);",
"<\/script></body></html>"
  ].join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/") return html(res, page());
    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`agent-intercom: ${host}:${port} is already in use`);
    process.exit(1);
  }
  throw error;
});

// Background reconcile so liveness/retention apply even without /api/state hits.
const reconcileTimer = setInterval(() => {
  let changed = reconcile();
  // prune expired rate-limit buckets
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(ip);
  }
  if (changed) persist();
}, 30000);
reconcileTimer.unref();

await initState();
server.listen(port, host, () => {
  console.log(
    `Agent Intercom running at http://${host}:${port}  (auth: ${token ? "on" : "OFF"}, view-token: ${viewToken ? "on" : "off"})`
  );
});
