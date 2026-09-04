// bb-plugin-google-antigravity-acp host entry.
//
// Ships bb's canonical ACP provider bridge (@get-bb/plugin-sdk/
// provider-bridge/acp — the same bridge the builtin provider-acp plugin
// uses). The runtime spawns this artifact as the provider bridge; per-agent
// launch facts arrive in `options.providerOptions.acpLaunchSpec` from the
// server-side registration in server.ts.
//
// We wrap the bridge to dynamically discover Antigravity's model options from
// the running ACP server (agy_acp_server.par), group reasoning variants into
// clean model families with supported reasoning efforts, and resolve launch
// options (model + reasoningLevel) to concrete backend model IDs.
//
// The same artifact also implements the plugin's host RPC (`bb
// google-antigravity-acp install` / `status`), so installs run on the machine
// where the daemon executes instead of on the bb server.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { agyHostContract } from "./contract.js";
import { probeLocal, runInstall } from "./install.js";

import {
  normalizeEffort as _normalizeEffort,
  parseRawModels as _parseRawModels,
  resolveRawModelId as _resolveRawModelId,
  rawListsEqual as _rawListsEqual,
  type RawModel,
  type ModelFamily,
  type AvailableModel,
} from "./model-utils.js";

// Re-export pure utils for tests and backward compat
export const normalizeEffort = _normalizeEffort;
export const parseRawModels = _parseRawModels;
export const resolveRawModelId = _resolveRawModelId;
export const rawListsEqual = _rawListsEqual;

const CACHE_FILE = path.join(
  os.homedir(),
  ".bb",
  "plugins",
  "google-antigravity-acp",
  "models-cache.json",
);

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — picker never stale, background refresh handles rotation

// ---------------------------------------------------------------------------
// Per-provider default configurability (BB settings pattern)
// ---------------------------------------------------------------------------

function getPreferredDefault(): { model: string; effort: string } | null {
  try {
    const p = path.join(os.homedir(), ".bb", "plugins", "google-antigravity-acp", "settings-cache.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.defaultModel && typeof j.defaultModel === "string" && j.defaultModel.trim()) {
        return {
          model: j.defaultModel.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, ""),
          effort: _normalizeEffort(j.defaultReasoningEffort || "medium"),
        };
      }
    }
  } catch {}
  const envModel = process.env.BB_ANTIGRAVITY_DEFAULT_MODEL;
  if (envModel && envModel.trim()) {
    return { model: envModel.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, ""), effort: _normalizeEffort(process.env.BB_ANTIGRAVITY_DEFAULT_REASONING || "medium") };
  }
  return null;
}

// Wrap parse to inject settings without changing pure util signature
function parseWithSettings(rawList: RawModel[]) {
  const pref = getPreferredDefault();
  return _parseRawModels(rawList, undefined, pref);
}

// ---- Discovery and caching ------------------------------------------------

let activeRawModels: RawModel[] = [];
let activeFamilies = new Map<string, ModelFamily>();
let activeModels: AvailableModel[] = [];
let activeDefaultFamilyId = "";
let isInitialized = false;
let discoveryPromise: Promise<void> | null = null;
let cacheTimestamp = 0;
let lastRefreshAt = 0;

function isCacheStale(): boolean {
  if (!cacheTimestamp) return true;
  return Date.now() - cacheTimestamp > CACHE_TTL_MS;
}

function loadFromDiskCache(): boolean {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(data.rawModels) && data.rawModels.length > 0) {
        activeRawModels = data.rawModels;
        cacheTimestamp = typeof data.timestamp === "number" ? data.timestamp : 0;
        const parsed = parseWithSettings(activeRawModels);
        activeFamilies = parsed.families;
        activeModels = parsed.models;
        activeDefaultFamilyId = parsed.defaultFamilyId;
        isInitialized = true;
        lastRefreshAt = cacheTimestamp || Date.now();
        return true;
      }
    }
  } catch {}
  return false;
}

function saveToDiskCache(rawModels: RawModel[]) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    cacheTimestamp = Date.now();
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ rawModels, timestamp: cacheTimestamp }), "utf8");
  } catch {}
}

async function queryAcpServer(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<RawModel[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const rl = readline.createInterface({ input: proc.stdout });
    let nextId = 1;
    const pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("ACP server query timed out"));
    }, 15000);

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } catch {}
    });

    function send(method: string, params: any) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "bb", version: "1.0.0" },
          clientCapabilities: {},
        });
        const session: any = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
        const modelOption = session?.configOptions?.find((c: any) => c.id === "model");
        const rawList = (modelOption?.options ?? []).map((o: any) => ({
          id: o.value,
          name: o.name ?? o.value,
        }));
        clearTimeout(timeout);
        proc.kill();
        resolve(rawList);
      } catch (err) {
        clearTimeout(timeout);
        proc.kill();
        reject(err);
      }
    })();
  });
}

async function refreshModels(launchSpec?: { command: string; args: string[]; env: Record<string, string> }) {
  if (discoveryPromise) return discoveryPromise;
  const cmd = launchSpec?.command || "agy_acp_server.par";
  const args = launchSpec?.args || [];
  const env = launchSpec?.env || {};

  discoveryPromise = queryAcpServer(cmd, args, env)
    .then((rawList) => {
      if (rawList && rawList.length > 0) {
        // Stale check: diff against current cache — handles added/deprecated models so picker never stale
        if (!isInitialized || !_rawListsEqual(rawList, activeRawModels)) {
          activeRawModels = rawList;
          const parsed = parseWithSettings(activeRawModels);
          activeFamilies = parsed.families;
          activeModels = parsed.models;
          activeDefaultFamilyId = parsed.defaultFamilyId;
          isInitialized = true;
          saveToDiskCache(rawList);
        } else {
          // No change — just bump timestamp to avoid re-querying
          cacheTimestamp = Date.now();
          try {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
            data.timestamp = cacheTimestamp;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
          } catch {}
        }
        lastRefreshAt = Date.now();
      }
    })
    .catch(() => {})
    .finally(() => {
      discoveryPromise = null;
    });

  return discoveryPromise;
}

// Attempt initial load from disk cache
loadFromDiskCache();

export const experimental_providerBridge = {
  experimental_apiVersion: 1 as const,
  handleLine: async (line: string, ctx?: any) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (parsed.method === "model/list") {
          const launchSpec = parsed.params?.providerOptions?.acpLaunchSpec;
          if (!isInitialized || isCacheStale()) {
            // Stale or cold — await discovery so first picker is fresh
            await refreshModels(launchSpec);
          } else {
            // Re-derive from cache to honor current defaultModel setting (no cache invalidation needed)
            const reparsed = parseWithSettings(activeRawModels);
            activeFamilies = reparsed.families;
            activeModels = reparsed.models;
            activeDefaultFamilyId = reparsed.defaultFamilyId;
            if (Date.now() - lastRefreshAt > 60_000) {
              // Background refresh (debounced 60s) to pick up added/deprecated models without blocking
              refreshModels(launchSpec);
            }
          }

          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                models: activeModels,
                selectedOnlyModels: [],
              },
            }) + "\n",
          );
          return;
        }

        if (
          parsed.method === "thread/start" ||
          parsed.method === "thread/resume" ||
          parsed.method === "thread/fork"
        ) {
          if (!parsed.params.options) {
            parsed.params.options = {};
          }
          if (!isInitialized) {
            loadFromDiskCache();
          }
          const resolved = resolveRawModelId(
            parsed.params.options.model,
            parsed.params.options.reasoningLevel,
            activeFamilies,
            activeDefaultFamilyId,
            activeRawModels,
          );
          parsed.params.options.model = resolved;
          line = JSON.stringify(parsed);
        }
      }
    } catch {
      // Fall through to default line handler on parse error
    }
    return experimental_acpProviderBridge.handleLine(line, ctx);
  },
  onClose: () => {
    return experimental_acpProviderBridge.onClose?.();
  },
};

export default experimental_defineHostEntry({
  contract: agyHostContract,
  handlers: {
    install: async (input) =>
      runInstall({
        installDir: input.installDir,
        binDir: input.binDir,
        force: input.force,
        updatePath: input.updatePath,
        source: input.source,
      }),
    probe: async () => probeLocal(),
  },
});
