// Shared client for the Agent Intercom hub: HTTP calls + local identity config.
// Used by both the MCP server (mcp/server.mjs) and the optional CLI (mcp/cli.mjs).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Config persists the hub connection (url, token) and this session's identity so
// the user enters them once at register time and later sends/inbox reuse them.
// Kept OUTSIDE the repo dir (which may itself be ~/.agent-intercom) to avoid clashes.
export const configPath = process.env.OFFICE_CONFIG || path.join(os.homedir(), ".office-relay-agent.json");

export async function loadConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

export async function saveConfig(config) {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return config;
}

export async function api(url, token, p, { method = "GET", body } = {}) {
  if (!url) {
    throw new Error("no hub URL configured — register first (office_register) or pass a url");
  }
  const res = await fetch(url.replace(/\/+$/, "") + p, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const health = (url, token) => api(url, token, "/api/health");
export const registerAgent = (url, token, agent) =>
  api(url, token, "/api/register", { method: "POST", body: agent });
export const heartbeat = (url, token, body) =>
  api(url, token, "/api/heartbeat", { method: "POST", body });
export const listState = (url, token) => api(url, token, "/api/state");
export const sendMessage = (url, token, message) =>
  api(url, token, "/api/send", { method: "POST", body: message });
export const getInbox = (url, token, agent, unread = true) =>
  api(url, token, `/api/inbox?agent=${encodeURIComponent(agent)}&unread=${unread}`);
export const markRead = (url, token, agent, ids) =>
  api(url, token, "/api/read", { method: "POST", body: { agent, ids } });
export const unregisterAgent = (url, token, id) =>
  api(url, token, "/api/unregister", { method: "POST", body: { id } });

export function defaultHost() {
  return process.env.OFFICE_AGENT_HOST || os.hostname() || "unknown-host";
}
