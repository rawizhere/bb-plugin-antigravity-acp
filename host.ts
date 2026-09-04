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

interface RawModel {
  id: string;
  name: string;
}

interface ModelFamily {
  id: string;
  displayName: string;
  variants: Map<string, string>; // effort -> rawId
  defaultEffort: string;
}

interface AvailableModelReasoningEffort {
  reasoningEffort: string;
  description: string;
}

interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: AvailableModelReasoningEffort[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

const CACHE_FILE = path.join(
  os.homedir(),
  ".bb",
  "plugins",
  "google-antigravity-acp",
  "models-cache.json",
);

function parseRawModels(rawList: RawModel[]): {
  families: Map<string, ModelFamily>;
  models: AvailableModel[];
  defaultFamilyId: string;
} {
  const families = new Map<string, ModelFamily>();

  for (const raw of rawList) {
    const rawId = raw.id;
    const rawName = raw.name || rawId;

    // Detect effort from name: e.g. "Gemini 3.7 Flash (High)"
    const effortMatch = rawName.match(
      /^(.*?)\s*\((High|Medium|Low|Low-Medium|None|Off|Min|Max|Default)\)$/i,
    );
    let displayName = rawName;
    let effort = "medium";

    if (effortMatch) {
      displayName = effortMatch[1].trim();
      effort = effortMatch[2].toLowerCase();
    } else {
      const idMatch = rawId.match(/^(.*?)-(low|medium|high)$/i);
      if (idMatch) {
        effort = idMatch[2].toLowerCase();
      }
    }

    // Derive family slug from displayName (e.g. "Gemini 3.7 Flash" -> "gemini-3.7-flash")
    const familyId = displayName
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "");

    let fam = families.get(familyId);
    if (!fam) {
      fam = {
        id: familyId,
        displayName,
        variants: new Map(),
        defaultEffort: "medium",
      };
      families.set(familyId, fam);
    }
    fam.variants.set(effort, rawId);
  }

  // Ensure medium effort is mapped if high exists
  for (const fam of families.values()) {
    if (!fam.variants.has("medium") && fam.variants.has("high")) {
      fam.variants.set("medium", fam.variants.get("high")!);
    }
    if (!fam.variants.has("medium") && fam.variants.size > 0) {
      fam.defaultEffort = fam.variants.keys().next().value!;
    }
  }

  // Pick default family: prefer gemini-3.7-flash, else first flash, else first model
  let defaultFamilyId = "";
  for (const id of families.keys()) {
    if (id === "gemini-3.7-flash") {
      defaultFamilyId = id;
      break;
    }
  }
  if (!defaultFamilyId) {
    for (const id of families.keys()) {
      if (id.includes("flash")) {
        defaultFamilyId = id;
        break;
      }
    }
  }
  if (!defaultFamilyId && families.size > 0) {
    defaultFamilyId = families.keys().next().value!;
  }

  const standardLadder = ["low", "medium", "high"];
  const models: AvailableModel[] = [];

  for (const fam of families.values()) {
    // Collect reasoning efforts preserving standard order where possible
    const efforts = standardLadder.filter((eff) => fam.variants.has(eff));
    for (const eff of fam.variants.keys()) {
      if (!efforts.includes(eff)) efforts.push(eff);
    }

    const supportedReasoningEfforts: AvailableModelReasoningEffort[] = efforts.map(
      (eff) => ({
        reasoningEffort: eff,
        description: `${eff.charAt(0).toUpperCase() + eff.slice(1)} reasoning effort`,
      }),
    );

    models.push({
      id: fam.id,
      model: fam.id,
      displayName: fam.displayName,
      description: "",
      supportedReasoningEfforts,
      defaultReasoningEffort: fam.defaultEffort,
      isDefault: fam.id === defaultFamilyId,
    });
  }

  return { families, models, defaultFamilyId };
}

function resolveRawModelId(
  model: string | undefined,
  reasoningLevel: string | undefined,
  families: Map<string, ModelFamily>,
  defaultFamilyId: string,
  rawModels: RawModel[],
): string {
  // If model is omitted or empty, use the catalog default model family
  const targetModel = model && model.trim() ? model.trim() : defaultFamilyId;

  // Check if it already directly matches any raw model id
  const rawHit = rawModels.find((r) => r.id === targetModel);
  if (rawHit) {
    return targetModel;
  }

  // Check if targetModel matches a discovered family
  const fam = families.get(targetModel);
  if (fam) {
    const effort = (reasoningLevel ?? fam.defaultEffort ?? "medium").toLowerCase();
    const variant = fam.variants.get(effort);
    if (variant) return variant;
    // Fallback: medium, then high, then first available variant
    return (
      fam.variants.get("medium") ??
      fam.variants.get("high") ??
      fam.variants.values().next().value ??
      targetModel
    );
  }

  // If model name is already a concrete variant with a known effort suffix
  if (
    targetModel.endsWith("-low") ||
    targetModel.endsWith("-medium") ||
    targetModel.endsWith("-high") ||
    targetModel === "gemini-pro-agent"
  ) {
    return targetModel;
  }

  // Generic fallback if unknown model
  if (reasoningLevel) {
    return `${targetModel}-${reasoningLevel.toLowerCase()}`;
  }
  return targetModel;
}

// ---- Discovery and caching ------------------------------------------------

let activeRawModels: RawModel[] = [];
let activeFamilies = new Map<string, ModelFamily>();
let activeModels: AvailableModel[] = [];
let activeDefaultFamilyId = "";
let isInitialized = false;
let discoveryPromise: Promise<void> | null = null;

function loadFromDiskCache(): boolean {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(data.rawModels) && data.rawModels.length > 0) {
        activeRawModels = data.rawModels;
        const parsed = parseRawModels(activeRawModels);
        activeFamilies = parsed.families;
        activeModels = parsed.models;
        activeDefaultFamilyId = parsed.defaultFamilyId;
        isInitialized = true;
        return true;
      }
    }
  } catch {}
  return false;
}

function saveToDiskCache(rawModels: RawModel[]) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ rawModels, timestamp: Date.now() }), "utf8");
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
        activeRawModels = rawList;
        const parsed = parseRawModels(activeRawModels);
        activeFamilies = parsed.families;
        activeModels = parsed.models;
        activeDefaultFamilyId = parsed.defaultFamilyId;
        isInitialized = true;
        saveToDiskCache(rawList);
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
          if (!isInitialized) {
            // Await discovery if not yet loaded
            await refreshModels(launchSpec);
          } else {
            // Trigger background refresh if already loaded
            refreshModels(launchSpec);
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
