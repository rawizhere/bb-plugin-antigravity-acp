import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";

type Message = Record<string, any>;
type Request = { method: string; threadId: string; providerThreadId?: string };

const RECOVERY_MESSAGE = "Antigravity lost its live session. BB will restart the agent and restore the saved conversation. The failed prompt is not replayed automatically.";
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function parseMessage(line: string): Message | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && value.jsonrpc === "2.0" ? value : null;
  } catch {
    return null;
  }
}

function isLostSession(message: unknown, providerThreadId?: string): boolean {
  if (typeof message !== "string") return false;
  if (providerThreadId && (message === `Session not found: ${providerThreadId}` || message === `Internal error: Session not found: ${providerThreadId}`)) return true;
  return message.startsWith("Agent connection was lost and could not be re-established: Failed to rebuild agent:");
}

/** Observe only provider errors, never model text, raw tool output or stderr. */
export function createSessionRecovery() {
  const sessions = new Map<string, string>();
  const invalidated = new Set<string>();
  const requests = new Map<string | number, Request>();

  function recovery(threadId?: string) {
    return {
      ...(threadId ? { threadId } : {}),
      kind: "restartRecommended" as const,
      message: RECOVERY_MESSAGE,
      retryable: false,
    };
  }

  return {
    beforeInput(line: string): string | null {
      const msg = parseMessage(line);
      if (!msg || (typeof msg.id !== "number" && typeof msg.id !== "string")) return null;
      const threadId = msg.params?.threadId;
      if (typeof threadId !== "string") return null;
      if ((msg.method === "turn/start" || msg.method === "turn/steer") && invalidated.has(threadId)) {
        return JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32000, message: RECOVERY_MESSAGE, data: { recovery: recovery() } },
        });
      }
      if (["thread/start", "thread/resume", "thread/stop", "turn/start", "turn/steer"].includes(msg.method)) {
        requests.set(msg.id, { method: msg.method, threadId, providerThreadId: msg.params?.providerThreadId });
      }
      return null;
    },

    afterOutput(line: string): { line: string; notification?: string } {
      const msg = parseMessage(line);
      if (!msg) return { line };
      if (msg.method === "thread/identity" && typeof msg.params?.threadId === "string" && typeof msg.params?.providerThreadId === "string") {
        sessions.set(msg.params.threadId, msg.params.providerThreadId);
      }
      if (msg.method === undefined && ("result" in msg || "error" in msg)) {
        const request = requests.get(msg.id);
        requests.delete(msg.id);
        if (request) {
          if ((request.method === "turn/start" || request.method === "turn/steer") && msg.error && isLostSession(msg.error.message, request.providerThreadId ?? sessions.get(request.threadId))) {
            invalidated.add(request.threadId);
            // A rejected request carries recovery on its response, not a second notification.
            msg.error.data = { ...msg.error.data, recovery: recovery() };
            return { line: JSON.stringify(msg) };
          }
          // Never request another automatic restart when the restore itself
          // fails: a persistently broken MCP must surface once, not loop.
          if ("result" in msg && (request.method === "thread/start" || request.method === "thread/resume")) {
            invalidated.delete(request.threadId);
          }
          if ("result" in msg && request.method === "thread/stop") {
            sessions.delete(request.threadId);
            invalidated.delete(request.threadId);
          }
        }
      }
      if (msg.method === "error" && typeof msg.params?.threadId === "string") {
        const threadId = msg.params.threadId;
        const sessionId = sessions.get(threadId);
        if (sessionId && (!msg.params.providerThreadId || msg.params.providerThreadId === sessionId) && !invalidated.has(threadId) && isLostSession(msg.params.message, sessionId)) {
          invalidated.add(threadId);
          return {
            line,
            notification: JSON.stringify({ jsonrpc: "2.0", method: "provider/recovery", params: recovery(threadId) }),
          };
        }
      }
      return { line };
    },
  };
}

/**
 * The published ACP bridge writes JSON-RPC directly to stdout and has no output
 * hook. Install a line adapter only in its dedicated bridge process (start),
 * never when host.ts is merely imported by a host RPC worker. Preserve the
 * original write contract and restore it when the bridge closes.
 */
export function withSessionRecovery(inner: ProviderBridgeEntry, output: NodeJS.WriteStream = process.stdout): ProviderBridgeEntry {
  const state = createSessionRecovery();
  let originalWrite: typeof output.write | undefined;
  let adapter: typeof output.write | undefined;
  let pending = "";

  function restore() {
    if (originalWrite && output.write === adapter) {
      if (pending) originalWrite.call(output, pending);
      pending = "";
      output.write = originalWrite;
    }
    originalWrite = undefined;
  }

  return {
    experimental_apiVersion: 1,
    start(context) {
      if (!originalWrite) {
        originalWrite = output.write;
        adapter = function (chunk: any, encoding?: any, callback?: any): boolean {
          const cb = typeof encoding === "function" ? encoding : callback;
          pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          let transformed = "";
          for (;;) {
            const index = pending.indexOf("\n");
            if (index < 0) break;
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            const result = state.afterOutput(line);
            transformed += result.line + "\n";
            if (result.notification) transformed += result.notification + "\n";
          }
          // Non-JSON output is not expected, but never retain an unbounded chunk.
          if (Buffer.byteLength(pending) > MAX_BUFFER_BYTES) {
            transformed += pending;
            pending = "";
          }
          return originalWrite!.call(output, transformed, typeof encoding === "string" ? encoding as BufferEncoding : "utf8", cb);
        } as typeof output.write;
        output.write = adapter;
      }
      inner.start?.(context);
    },
    handleLine(line) {
      const rejection = state.beforeInput(line);
      if (rejection) {
        output.write(rejection + "\n");
        return;
      }
      return inner.handleLine(line);
    },
    onClose() { restore(); inner.onClose?.(); },
    // Preserve the loader's default signal termination when the underlying
    // bridge has no custom handler; a no-op hook would swallow that signal.
    ...(inner.onSigterm ? { onSigterm() { restore(); inner.onSigterm!(); } } : {}),
    ...(inner.onSigint ? { onSigint() { restore(); inner.onSigint!(); } } : {}),
  };
}
