import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSessionRecovery, withSessionRecovery } from "../session-recovery.ts";

// The SDK's published ESM bundle includes CommonJS dependencies; BB's host
// loader provides require as well. Keep the standalone test loader equivalent.
globalThis.require = createRequire(import.meta.url);
const { providerRecoveryNotificationSchema, bridgeErrorDataSchema } = await import("@get-bb/plugin-sdk/provider-bridge");

const wire = (method, params) => JSON.stringify({ jsonrpc: "2.0", method, params });
const request = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const identity = (threadId = "thread-1", providerThreadId = "saved-session") => wire("thread/identity", { threadId, providerThreadId });
const lost = (message = "Internal error: Session not found: saved-session", threadId = "thread-1", providerThreadId = "saved-session") => wire("error", { threadId, providerThreadId, message });

test("lost session emits one typed restart after the original error; failed prompt is never replayed", () => {
  const state = createSessionRecovery();
  state.afterOutput(identity());
  assert.equal(state.beforeInput(request(1, "turn/start", { threadId: "thread-1" })), null);
  state.afterOutput(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  const result = state.afterOutput(lost());
  assert.equal(result.line, lost());
  const notification = JSON.parse(result.notification);
  assert.equal(notification.method, "provider/recovery");
  assert.equal(notification.params.kind, "restartRecommended");
  assert.equal(notification.params.threadId, "thread-1");
  assert.equal(notification.params.retryable, false);
  providerRecoveryNotificationSchema.parse(notification.params);
  assert.equal(state.afterOutput(lost()).notification, undefined);
  const blocked = JSON.parse(state.beforeInput(request(2, "turn/start", { threadId: "thread-1" })));
  assert.equal(blocked.id, 2);
  assert.equal(blocked.error.data.recovery.kind, "restartRecommended");
  assert.equal(blocked.error.data.recovery.retryable, false);
  bridgeErrorDataSchema.parse(blocked.error.data);
});

test("a confirmed rebuild failure also invalidates the live session", () => {
  const state = createSessionRecovery();
  state.afterOutput(identity());
  const result = state.afterOutput(lost("Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK)"));
  assert.equal(JSON.parse(result.notification).params.kind, "restartRecommended");
});

test("model text, tool output, MCP errors, unknown threads and unrelated session IDs never trigger recovery", () => {
  const state = createSessionRecovery();
  state.afterOutput(identity());
  for (const line of [
    wire("thread/delta", { threadId: "thread-1", deltas: [{ kind: "item.text.append", text: "Internal error: Session not found: saved-session" }] }),
    wire("provider/raw", { threadId: "thread-1", message: "Internal error: Session not found: saved-session" }),
    lost("The MCP server 'raindrop' failed to initialize: ETIMEDOUT"),
    lost("Tool reported Session not found: saved-session"),
    lost("Internal error: Session not found: other-session"),
    lost(undefined, "other-thread"),
    lost(undefined, "thread-1", "other-session"),
    "not JSON",
  ]) assert.deepEqual(state.afterOutput(line), { line });
});

test("rejected turn carries recovery once on the correlated response", () => {
  const state = createSessionRecovery();
  state.afterOutput(identity());
  state.beforeInput(request(7, "turn/start", { threadId: "thread-1", providerThreadId: "saved-session" }));
  const response = { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Session not found: saved-session", data: { diagnostic: "kept" } } };
  const output = state.afterOutput(JSON.stringify(response));
  assert.equal(output.notification, undefined);
  const parsed = JSON.parse(output.line);
  assert.equal(parsed.error.data.diagnostic, "kept");
  assert.equal(parsed.error.data.recovery.retryable, false);
  assert.equal(parsed.error.data.recovery.threadId, undefined);
  bridgeErrorDataSchema.parse(parsed.error.data);
});

test("failed restore stays a visible failure and does not request an endless restart loop", () => {
  const state = createSessionRecovery();
  state.beforeInput(request(7, "thread/resume", { threadId: "thread-1", providerThreadId: "saved-session" }));
  const line = JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Session not found: saved-session" } });
  assert.deepEqual(state.afterOutput(line), { line });
});

test("restoring the session permits only new user input and isolates sibling threads", () => {
  const state = createSessionRecovery();
  state.afterOutput(identity());
  state.afterOutput(identity("thread-2", "sibling-session"));
  state.afterOutput(lost());
  assert.equal(state.beforeInput(request(3, "turn/start", { threadId: "thread-2" })), null);
  state.beforeInput(request(4, "thread/resume", { threadId: "thread-1", providerThreadId: "saved-session" }));
  state.afterOutput(identity());
  assert.ok(state.beforeInput(request(5, "turn/steer", { threadId: "thread-1" })));
  state.afterOutput(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { providerThreadId: "saved-session" } }));
  assert.equal(state.beforeInput(request(6, "turn/start", { threadId: "thread-1" })), null);
});

test("adapter is inert on import, handles split lines, preserves error ordering and restores stdout", async () => {
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, cb) { chunks.push(chunk.toString()); cb(); } });
  const original = sink.write;
  const received = [];
  const lifecycle = [];
  const inner = {
    experimental_apiVersion: 1,
    start(ctx) { lifecycle.push(ctx.pluginId); },
    handleLine(line) { received.push(line); },
    onClose() { lifecycle.push("closed"); },
  };
  const bridge = withSessionRecovery(inner, sink);
  assert.equal(sink.write, original);
  assert.equal(bridge.onSigterm, undefined);
  assert.equal(bridge.onSigint, undefined);
  bridge.start({ pluginId: "test", dataDir: "/unused", tempDir: "/unused" });
  sink.write(identity() + "\n");
  const split = lost();
  sink.write(split.slice(0, 13));
  await new Promise(resolve => sink.write(split.slice(13) + "\n", resolve));
  const output = chunks.join("").trim().split("\n").map(JSON.parse);
  assert.equal(output[1].method, "error");
  assert.equal(output[2].method, "provider/recovery");
  bridge.handleLine(request(8, "turn/start", { threadId: "thread-1", input: ["do not replay"] }));
  assert.deepEqual(received, []);
  bridge.handleLine(request(9, "thread/stop", { threadId: "thread-1" }));
  assert.equal(received.length, 1);
  bridge.onClose();
  assert.equal(sink.write, original);
  assert.deepEqual(lifecycle, ["test", "closed"]);
});

test("real ACP bridge: lost-session response requests restart, resumes the same ID and never repeats the failed prompt", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agy-recovery-"));
  const audit = join(root, "audit.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("fixtures/recovery-bridge.mjs", import.meta.url))], {
    env: { ...process.env, RECOVERY_TEST_ROOT: root, RECOVERY_TEST_AUDIT: audit },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let stderr = "";
  const messages = [];
  const waiters = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  child.on("exit", code => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`bridge exited ${code}: ${stderr}`));
  });
  const waitFor = predicate => {
    const found = messages.find(predicate);
    return found ? Promise.resolve(found) : new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject }));
  };
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    child.stdin.write(request(id, method, params) + "\n");
    return waitFor(msg => msg.id === id && msg.method === undefined);
  }
  assert.ok((await call("initialize", { protocolVersion: 3, grammarVersions: [3, 3], client: { name: "regression-test", version: "1" } })).result);
  const options = {
    permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
    providerOptions: { acpLaunchSpec: { displayName: "Recovery test", command: process.execPath, args: [fileURLToPath(new URL("fixtures/recovery-agent.mjs", import.meta.url))], env: { RECOVERY_TEST_AUDIT: audit } } },
  };
  const construction = { threadId: "thread-1", cwd: root, instructionMode: "append", options };
  const started = await call("thread/start", construction);
  assert.equal(started.result?.providerThreadId, "saved-session", JSON.stringify(started));
  const turn = text => ({ threadId: "thread-1", providerThreadId: "saved-session", clientRequestId: "creq_23456789ab", input: [{ type: "text", text }], options });
  assert.ok((await call("turn/start", turn("original operation"))).result);
  await waitFor(msg => msg.method === "error");
  const recovery = await waitFor(msg => msg.method === "provider/recovery");
  assert.equal(recovery.params.retryable, false);
  assert.equal(recovery.params.kind, "restartRecommended");
  assert.equal((await call("turn/start", turn("must not reach broken agent"))).error.data.recovery.kind, "restartRecommended");
  await call("thread/stop", { threadId: "thread-1", providerThreadId: "saved-session", intent: "release", activeTurnId: null });
  assert.equal((await call("thread/resume", { ...construction, providerThreadId: "saved-session" })).result?.providerThreadId, "saved-session");
  await call("turn/start", turn("new user request"));
  await waitFor(msg => msg.method === "thread/delta" && msg.params.deltas.some(delta => delta.kind === "turn.boundary"));
  const calls = (await readFile(audit, "utf8")).trim().split("\n").map(JSON.parse);
  const prompts = calls.filter(call => call.method === "session/prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.prompt[0].text, "original operation");
  assert.equal(prompts[1].params.prompt[0].text, "new user request");
  assert.equal(calls.filter(call => call.method === "session/load").length, 1);
  assert.equal(messages.filter(msg => msg.method === "provider/recovery").length, 1);
  child.stdin.end();
});
