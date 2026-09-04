// bb-plugin-google-antigravity-acp host entry.
//
// Ships bb's canonical ACP provider bridge (@get-bb/plugin-sdk/
// provider-bridge/acp — the same bridge the builtin provider-acp plugin
// uses). The runtime spawns this artifact as the provider bridge; per-agent
// launch facts arrive in `options.providerOptions.acpLaunchSpec` from the
// server-side registration in server.ts.
//
// We wrap the bridge to aggregate Antigravity's raw reasoning variants
// (e.g. gemini-3.7-flash-high, gemini-3.7-flash-medium, gemini-3.7-flash-low)
// into clean model families (gemini-3.7-flash with low/medium/high efforts),
// preventing double naming in the UI and enabling clean agent workflow
// configurations.
//
// The same artifact also implements the plugin's host RPC (`bb
// google-antigravity-acp install` / `status`), so installs run on the machine
// where the daemon executes instead of on the bb server.
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { agyHostContract } from "./contract.js";
import { probeLocal, runInstall } from "./install.js";

interface AvailableModelReasoningEffort {
  reasoningEffort: "low" | "medium" | "high";
  description: string;
}

interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: AvailableModelReasoningEffort[];
  defaultReasoningEffort: "low" | "medium" | "high";
  isDefault: boolean;
}

const REASONING_EFFORTS: AvailableModelReasoningEffort[] = [
  { reasoningEffort: "low", description: "Low reasoning effort" },
  { reasoningEffort: "medium", description: "Medium reasoning effort" },
  { reasoningEffort: "high", description: "High reasoning effort" },
];

const DEFAULT_MODELS: AvailableModel[] = [
  {
    id: "gemini-3.8-flash",
    model: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    description: "",
    supportedReasoningEfforts: REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "gemini-3.7-flash",
    model: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    description: "",
    supportedReasoningEfforts: REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "gemini-3.6-flash",
    model: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    description: "",
    supportedReasoningEfforts: REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "gemini-3.1-pro",
    model: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    description: "",
    supportedReasoningEfforts: REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
];

const KNOWN_RAW_MAP: Record<string, Record<string, string>> = {
  "gemini-3.8-flash": {
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
  },
  "gemini-3.7-flash": {
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high",
  },
  "gemini-3.6-flash": {
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
  },
  "gemini-3.1-pro": {
    low: "gemini-3.1-pro-low",
    medium: "gemini-pro-agent",
    high: "gemini-pro-agent",
  },
  "gemini-pro": {
    low: "gemini-3.1-pro-low",
    medium: "gemini-pro-agent",
    high: "gemini-pro-agent",
  },
  "gemini-pro-agent": {
    low: "gemini-3.1-pro-low",
    medium: "gemini-pro-agent",
    high: "gemini-pro-agent",
  },
};

function cleanDisplayName(name: string): string {
  return name.replace(/\s*\((?:High|Medium|Low)\)\s*/gi, "").trim();
}

function parseRawVariant(id: string, name: string): { familyId: string; effort: "low" | "medium" | "high"; displayName: string } {
  if (id === "gemini-pro-agent") {
    return { familyId: "gemini-3.1-pro", effort: "high", displayName: "Gemini 3.1 Pro" };
  }
  for (const effort of ["high", "medium", "low"] as const) {
    if (id.endsWith(`-${effort}`)) {
      const familyId = id.slice(0, -(effort.length + 1));
      return { familyId, effort, displayName: cleanDisplayName(name) };
    }
  }
  return { familyId: id, effort: "medium", displayName: cleanDisplayName(name) };
}

function groupRawModels(rawModels: Array<{ id: string; name: string }>): AvailableModel[] {
  const families = new Map<
    string,
    { id: string; displayName: string; efforts: Set<string>; rawByEffort: Map<string, string> }
  >();

  for (const raw of rawModels) {
    const { familyId, effort, displayName } = parseRawVariant(raw.id, raw.name);
    let entry = families.get(familyId);
    if (!entry) {
      entry = {
        id: familyId,
        displayName,
        efforts: new Set(),
        rawByEffort: new Map(),
      };
      families.set(familyId, entry);
    }
    entry.efforts.add(effort);
    entry.rawByEffort.set(effort, raw.id);
  }

  const ladder = ["low", "medium", "high"] as const;
  const result: AvailableModel[] = [];

  for (const [id, f] of families) {
    if (!f.rawByEffort.has("medium") && f.rawByEffort.has("high")) {
      f.efforts.add("medium");
      f.rawByEffort.set("medium", f.rawByEffort.get("high")!);
    }
    const supportedReasoningEfforts = ladder
      .filter((lvl) => f.efforts.has(lvl))
      .map((lvl) => ({
        reasoningEffort: lvl,
        description: `${lvl.charAt(0).toUpperCase() + lvl.slice(1)} reasoning effort`,
      }));

    result.push({
      id,
      model: id,
      displayName: f.displayName,
      description: "",
      supportedReasoningEfforts,
      defaultReasoningEffort: "medium",
      isDefault: id === "gemini-3.7-flash",
    });
  }

  return result.length > 0 ? result : DEFAULT_MODELS;
}

function resolveRawModelId(model: string, reasoningLevel?: string): string {
  const family = KNOWN_RAW_MAP[model];
  if (family) {
    const level = reasoningLevel === "low" || reasoningLevel === "high" ? reasoningLevel : "medium";
    return family[level] ?? family.medium;
  }
  // If model name is already a concrete variant ending in -low, -medium, -high, or gemini-pro-agent
  if (model.endsWith("-low") || model.endsWith("-medium") || model.endsWith("-high") || model === "gemini-pro-agent") {
    return model;
  }
  if (model.startsWith("gemini-")) {
    const level = reasoningLevel === "low" || reasoningLevel === "high" ? reasoningLevel : "medium";
    return `${model}-${level}`;
  }
  return model;
}

let cachedModels: AvailableModel[] = DEFAULT_MODELS;
let discoveryPromise: Promise<AvailableModel[]> | null = null;

async function queryAcpModels(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<Array<{ id: string; name: string }>> {
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
      reject(new Error("ACP model query timed out"));
    }, 5000);

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } catch {
        // ignore
      }
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
        const rawModels = (modelOption?.options ?? []).map((o: any) => ({
          id: o.value,
          name: o.name ?? o.value,
        }));
        clearTimeout(timeout);
        proc.kill();
        resolve(rawModels);
      } catch (err) {
        clearTimeout(timeout);
        proc.kill();
        reject(err);
      }
    })();
  });
}

function refreshModelsInBackground(launchSpec?: { command: string; args: string[]; env: Record<string, string> }) {
  if (discoveryPromise || !launchSpec?.command) return;
  discoveryPromise = queryAcpModels(launchSpec.command, launchSpec.args ?? [], launchSpec.env ?? {})
    .then((raw) => {
      if (raw && raw.length > 0) {
        cachedModels = groupRawModels(raw);
      }
      return cachedModels;
    })
    .catch(() => cachedModels)
    .finally(() => {
      discoveryPromise = null;
    });
}

export const experimental_providerBridge = {
  experimental_apiVersion: 1 as const,
  handleLine: async (line: string, ctx?: any) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (parsed.method === "model/list") {
          const launchSpec = parsed.params?.providerOptions?.acpLaunchSpec;
          refreshModelsInBackground(launchSpec);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                models: cachedModels,
                selectedOnlyModels: [],
              },
            }) + "\n",
          );
          return;
        }

        if (
          (parsed.method === "thread/start" ||
            parsed.method === "thread/resume" ||
            parsed.method === "thread/fork") &&
          parsed.params?.options?.model
        ) {
          const resolved = resolveRawModelId(
            parsed.params.options.model,
            parsed.params.options.reasoningLevel,
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
