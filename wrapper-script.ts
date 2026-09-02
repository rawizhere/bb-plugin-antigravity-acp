export const WRAPPER_SCRIPT_CONTENT = `#!/usr/bin/env node

/**
 * Antigravity ACP Server Wrapper / Usage Proxy
 *
 * Transparently wraps Google's \`agy_acp_server.par\` and injects standard ACP
 * \`session/update\` notifications with \`sessionUpdate: "usage_update"\` whenever
 * turns complete or progress.
 *
 * Google's internal ACP server records exact token counts in the conversation's
 * local SQLite database (~/.gemini/antigravity-acp/conversations/<sessionId>.db),
 * but omits emitting \`usage_update\` over the ACP stdio bridge. This wrapper
 * extracts the usage metadata and emits standard ACP notifications so that
 * BB and other ACP clients receive real-time context window usage.
 */

// Suppress experimental warnings (e.g. node:sqlite)
process.removeAllListeners("warning");

const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { existsSync, realpathSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const readline = require("node:readline");

function resolveRealBinary() {
  if (process.env.ANTIGRAVITY_REAL_SERVER_PATH) {
    return process.env.ANTIGRAVITY_REAL_SERVER_PATH;
  }

  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "agy_acp_server.exe" : "agy_acp_server.par";
  const rawBinaryName = isWindows ? "agy_acp_server_raw.exe" : "agy_acp_server_raw.par";

  // Priority 1: Check the standard opt location where the plugin installs the raw binary
  const optPath = join(homedir(), ".local", "opt", "agy-acp-server", binaryName);
  if (existsSync(optPath)) {
    return optPath;
  }

  // Priority 2: Check raw binary link in ~/.local/bin
  const rawBin = join(homedir(), ".local", "bin", rawBinaryName);
  if (existsSync(rawBin)) {
    return rawBin;
  }

  // Priority 3: Search PATH for another binary with the same name that isn't this script
  const pathDirs = (process.env.PATH ?? "").split(isWindows ? ";" : ":");
  let selfReal = null;
  try {
    selfReal = realpathSync(process.argv[1]);
  } catch {}

  for (const dir of pathDirs) {
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) {
      try {
        if (selfReal && realpathSync(candidate) === selfReal) {
          continue;
        }
      } catch {}
      return candidate;
    }
  }

  throw new Error(
    \`Antigravity server binary "\${binaryName}" not found. Run "bb google-antigravity-acp install" to install it.\`
  );
}

function parsePbVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  while (offset < buf.length) {
    const b = BigInt(buf[offset++]);
    res |= (b & 0x7fn) << shift;
    shift += 7n;
    if (!(b & 0x80n)) break;
  }
  return [Number(res), offset];
}

function parsePb(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    let tag;
    [tag, offset] = parsePbVarint(buf, offset);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      let val;
      [val, offset] = parsePbVarint(buf, offset);
      fields.push({ fieldNum, wireType, val });
    } else if (wireType === 2) {
      let len;
      [len, offset] = parsePbVarint(buf, offset);
      if (offset + len > buf.length) break;
      const val = buf.subarray(offset, offset + len);
      offset += len;
      fields.push({ fieldNum, wireType, val });
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function extractContextUsage(dbPath) {
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 1"
      )
      .get();
    if (!row || !row.metadata) return null;
    const fields = parsePb(row.metadata);
    let used = 0;
    let size = 1_000_000;
    for (const f of fields) {
      if (f.fieldNum === 9 && f.wireType === 2) {
        const u = parsePb(f.val);
        let f5 = 0;
        let f2 = 0;
        for (const item of u) {
          if (item.fieldNum === 5) f5 = item.val;
          if (item.fieldNum === 2) f2 = item.val;
        }
        used = f5 + f2;
      }
      if (f.fieldNum === 24 && f.wireType === 2) {
        const m = parsePb(f.val);
        for (const item of m) {
          if (item.fieldNum === 4 && item.val > 0) {
            size = item.val;
          }
        }
      }
    }
    return { used, size };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function main() {
  const realBin = resolveRealBinary();
  const child = spawn(realBin, process.argv.slice(2), {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  let currentSessionId = null;
  let activePromptRequestId = null;
  let lastReportedUsed = -1;

  const geminiHome = process.env.GEMINI_HOME || join(homedir(), ".gemini");

  function getDbPath(sessionId) {
    if (!sessionId) return null;
    return join(geminiHome, "antigravity-acp", "conversations", \`\${sessionId}.db\`);
  }

  function maybeEmitUsageUpdate(sessionId) {
    if (!sessionId) return;
    const dbPath = getDbPath(sessionId);
    if (!dbPath) return;

    const usage = extractContextUsage(dbPath);
    if (!usage || usage.used <= 0) return;
    if (usage.used === lastReportedUsed) return;

    lastReportedUsed = usage.used;
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: usage.used,
          size: usage.size,
        },
      },
    };
    process.stdout.write(JSON.stringify(notification) + "\\n");
  }

  // Handle client -> agent input
  const rlIn = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rlIn.on("line", (line) => {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "session/prompt") {
          activePromptRequestId = msg.id;
          if (msg.params?.sessionId) {
            currentSessionId = msg.params.sessionId;
          }
        } else if (msg.method === "session/load") {
          if (msg.params?.sessionId) {
            currentSessionId = msg.params.sessionId;
          }
        }
      } catch {}
    }
    child.stdin.write(line + "\\n");
  });

  rlIn.on("close", () => {
    child.stdin.end();
  });

  // Handle agent -> client output
  const rlOut = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  rlOut.on("line", (line) => {
    if (!line.trim()) {
      process.stdout.write(line + "\\n");
      return;
    }

    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(line + "\\n");
      return;
    }

    // Check for sessionId in responses or updates
    if (msg.result?.sessionId) {
      currentSessionId = msg.result.sessionId;
    } else if (msg.params?.sessionId) {
      currentSessionId = msg.params.sessionId;
    }

    // When tool calls or step updates stream, check if we can emit an intermediate usage update
    if (msg.method === "session/update") {
      const updateKind = msg.params?.update?.sessionUpdate;
      if (updateKind === "tool_call" || updateKind === "plan") {
        maybeEmitUsageUpdate(currentSessionId);
      }
    }

    // When the prompt response completes the turn, emit final usage BEFORE returning the result
    if (activePromptRequestId !== null && msg.id === activePromptRequestId) {
      maybeEmitUsageUpdate(currentSessionId);
      activePromptRequestId = null;
    }

    process.stdout.write(line + "\\n");
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(\`Antigravity wrapper child error: \${err.message}\\n\`);
    process.exit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

main();
`;
