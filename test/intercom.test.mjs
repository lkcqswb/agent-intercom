// Integration tests: a throwaway hub on a local port plus real MCP server
// processes driven over stdio, the same way Claude Code / Codex drive them.
// Run with `npm test` (node:test, no dependencies).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 40000 + (process.pid % 20000);
const hubUrl = `http://127.0.0.1:${port}`;
let dir;
let hub;

async function api(p, { method = "GET", body } = {}) {
  const res = await fetch(hubUrl + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "intercom-test-"));
  hub = spawn(process.execPath, [path.join(root, "hub/relay.mjs")], {
    env: { ...process.env, OFFICE_PORT: String(port), OFFICE_STATE_PATH: path.join(dir, "state.json"), OFFICE_TOKEN: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    hub.stdout.on("data", (chunk) => String(chunk).includes("running at") && resolve());
    hub.on("exit", (code) => reject(new Error(`hub exited ${code}`)));
  });
});

after(async () => {
  hub?.kill();
  await rm(dir, { recursive: true, force: true });
});

// Minimal MCP client over stdio.
function startMcp(name, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, "mcp/server.mjs")], {
    env: { ...process.env, OFFICE_CONFIG: path.join(dir, `${name}.json`), OFFICE_PUSH: "", ...extraEnv },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        notifications.push(msg);
      }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const start = (method, params) => {
    const id = nextId++;
    const done = new Promise((resolve) => pending.set(id, resolve));
    send({ id, method, params });
    return { id, done };
  };
  const request = (method, params) => start(method, params).done;
  const text = (res) => res.result.content.map((c) => c.text).join("\n");
  const call = async (tool, args = {}) => text(await request("tools/call", { name: tool, arguments: args }));
  const startCall = (tool, args = {}) => {
    const { id, done } = start("tools/call", { name: tool, arguments: args });
    return { id, done: done.then(text) };
  };
  return {
    child,
    notifications,
    request,
    call,
    startCall,
    notify: (method, params) => send({ method, params }),
    init: (clientName = "test-client") =>
      request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } }),
    register: (agentId, extra = {}) =>
      call("office_register", { agentId, role: "test", host: "ci", url: hubUrl, token: "", ...extra }),
    stop: () => child.kill(),
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "mcp/cli.mjs"), ...args], {
      env: { ...process.env, OFFICE_URL: hubUrl, OFFICE_TOKEN: "", OFFICE_CONFIG: path.join(dir, "cli.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test("broadcast reaches every other agent once, each with its own read state", async () => {
  for (const id of ["bc-a", "bc-b", "bc-c"]) await api("/api/register", { method: "POST", body: { id } });
  const sent = await api("/api/send", { method: "POST", body: { from: "bc-a", to: "all", body: "hello all" } });
  assert.equal(sent.to, "all");
  assert.ok(!sent.recipients.includes("bc-a"));
  assert.deepEqual(await api("/api/inbox?agent=bc-a"), []);
  await api("/api/read", { method: "POST", body: { agent: "bc-b" } });
  const forC = await api("/api/inbox?agent=bc-c");
  assert.equal(forC.length, 1);
  assert.equal(forC[0].body, "hello all");
  const feed = await api("/api/feed");
  assert.equal(feed.messages.filter((m) => m.id === sent.id).length, 1, "UI shows the broadcast once");
});

test("long-poll answers on send, times out with [], and wake=1 skips FYIs", async () => {
  await api("/api/register", { method: "POST", body: { id: "lp-b" } });
  const empty = await api("/api/inbox/wait?agent=lp-b&timeout=1");
  assert.deepEqual(empty, []);

  const started = Date.now();
  const waiting = api("/api/inbox/wait?agent=lp-b&timeout=10&wake=1");
  await new Promise((r) => setTimeout(r, 200));
  await api("/api/send", { method: "POST", body: { from: "lp-a", to: "lp-b", body: "fyi only", wake: false } });
  await new Promise((r) => setTimeout(r, 200));
  await api("/api/send", { method: "POST", body: { from: "lp-a", to: "lp-b", body: "act on this" } });
  const got = await waiting;
  assert.ok(Date.now() - started < 3000, "returned promptly after the wake-worthy message");
  assert.deepEqual(got.map((m) => m.body), ["fyi only", "act on this"]);
  assert.ok(got[1].seq > got[0].seq);
});

test("loop guard rejects an identical repeat to the same target", async () => {
  await api("/api/send", { method: "POST", body: { from: "lg-a", to: "lg-b", body: "same text" } });
  await assert.rejects(
    api("/api/send", { method: "POST", body: { from: "lg-a", to: "lg-b", body: "same text" } }),
    (error) => error.status === 429
  );
});

test("office_wait returns the next message and marks it read", async () => {
  const a = startMcp("w-a");
  const b = startMcp("w-b");
  try {
    await a.init();
    await b.init();
    await a.register("w-a");
    await b.register("w-b");
    const waiting = b.call("office_wait", { timeoutSec: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await a.call("office_send", { to: "w-b", body: "please rebuild" });
    const text = await waiting;
    assert.match(text, /w-a -> w-b/);
    assert.match(text, /please rebuild/);
    assert.ok(await until(async () => (await api("/api/inbox?agent=w-b")).length === 0), "marked read on the hub");
  } finally {
    a.stop();
    b.stop();
  }
});

test("office_send waitForReply returns the answer in the same tool call", async () => {
  const a = startMcp("r-a");
  const b = startMcp("r-b");
  try {
    await a.init();
    await b.init();
    await a.register("r-a");
    await b.register("r-b");
    const asking = a.call("office_send", { to: "r-b", body: "what is 2+2?", waitForReply: 10 });
    let question;
    assert.ok(await until(async () => (question = (await api("/api/inbox?agent=r-b"))[0])));
    await b.call("office_send", { to: "r-a", body: "4", replyTo: question.id });
    const text = await asking;
    assert.match(text, /Reply:/);
    assert.match(text, new RegExp(`reply to ${question.id}`));
  } finally {
    a.stop();
    b.stop();
  }
});

test("unread mail piggybacks on the next tool result exactly once", async () => {
  const a = startMcp("p-a");
  const b = startMcp("p-b");
  try {
    await a.init();
    await b.init();
    await a.register("p-a");
    await b.register("p-b");
    await a.call("office_send", { to: "p-b", body: "status update please" });
    const first = await b.call("office_sessions");
    assert.match(first, /📬 Unread mail for p-b/);
    assert.match(first, /status update please/);
    const second = await b.call("office_sessions");
    assert.doesNotMatch(second, /status update please/);
  } finally {
    a.stop();
    b.stop();
  }
});

test("a session never reads mail for the identity saved by another session", async () => {
  const shared = { OFFICE_CONFIG: path.join(dir, "shared.json") };
  const x = startMcp("shared-x", shared);
  const y = startMcp("shared-y", shared);
  try {
    await x.init();
    await y.init();
    await x.register("sh-x");
    await y.register("sh-y"); // the shared config now names sh-y
    await api("/api/send", { method: "POST", body: { from: "z", to: "sh-x", body: "for x only" } });
    const yView = await y.call("office_sessions");
    assert.doesNotMatch(yView, /for x only/);
    const xView = await x.call("office_sessions");
    assert.match(xView, /for x only/);
  } finally {
    x.stop();
    y.stop();
  }
});

test("stop-hook wait blocks the stop with the mail, or allows it on timeout", async () => {
  const a = startMcp("sh-a");
  const b = startMcp("sh-b");
  try {
    await a.init();
    await b.init("codex-mcp-client");
    await a.register("sh-a");
    const registered = await b.register("sh-b");
    assert.match(registered, /hooks\.json/, "Codex gets the Stop hook setup note");

    assert.equal(await b.call("office_wait", { mode: "stop-hook", timeoutSec: 1 }), "", "timeout allows the stop");

    const waiting = b.call("office_wait", { mode: "stop-hook", timeoutSec: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await a.call("office_send", { to: "sh-b", body: "fyi first", wake: false });
    await a.call("office_send", { to: "sh-b", body: "run the eval" });
    const decision = JSON.parse(await waiting);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /run the eval/);
    assert.match(decision.reason, /fyi first/, "pending FYIs ride along");
  } finally {
    a.stop();
    b.stop();
  }
});

test("stop-hook wait passes through for unregistered or opted-out sessions", async () => {
  const x = startMcp("sh-x");
  const y = startMcp("sh-y");
  try {
    await x.init();
    await y.init();
    const started = Date.now();
    assert.equal(await x.call("office_wait", { mode: "stop-hook", timeoutSec: 30 }), "");
    await y.register("sh-y", { waitOnStop: false });
    assert.equal(await y.call("office_wait", { mode: "stop-hook", timeoutSec: 30 }), "");
    assert.ok(Date.now() - started < 3000);
  } finally {
    x.stop();
    y.stop();
  }
});

test("a cancelled wait does not consume mail that arrives later", async () => {
  const b = startMcp("cx-b");
  try {
    await b.init();
    await b.register("cx-b");
    const { id, done } = b.startCall("office_wait", { mode: "stop-hook", timeoutSec: 30 });
    await new Promise((r) => setTimeout(r, 300));
    b.notify("notifications/cancelled", { requestId: id, reason: "hook timeout" });
    assert.equal(await done, "");
    await api("/api/send", { method: "POST", body: { from: "cx-a", to: "cx-b", body: "still here?" } });
    await new Promise((r) => setTimeout(r, 500));
    const unread = await api("/api/inbox?agent=cx-b");
    assert.deepEqual(unread.map((m) => m.body), ["still here?"]);
  } finally {
    b.stop();
  }
});

test("CLI watch --stop-hook prints hook JSON on mail and nothing on timeout", async () => {
  await api("/api/register", { method: "POST", body: { id: "cli-b" } });
  const quiet = await runCli(["watch", "cli-b", "--stop-hook", "--timeout", "1"]);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, "");
  const watching = runCli(["watch", "cli-b", "--stop-hook", "--timeout", "10"]);
  await new Promise((r) => setTimeout(r, 500));
  await api("/api/send", { method: "POST", body: { from: "cli-a", to: "cli-b", body: "wake up" } });
  const loud = await watching;
  assert.equal(loud.code, 0);
  const decision = JSON.parse(loud.out);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /wake up/);
});
