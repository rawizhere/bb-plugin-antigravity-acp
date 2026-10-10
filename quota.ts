import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { execSync } from "node:child_process";

export interface QuotaWindow {
  id: string;
  kind: "five-hour" | "daily" | "weekly" | "custom";
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  model: string | null;
}

export interface QuotaResult {
  ok: boolean;
  error: string | null;
  accountEmail: string | null;
  planLabel: string | null;
  windows: QuotaWindow[];
}

function findDaemon(): { pid: number | null; csrf: string | null } {
  let psOutput = "";
  try {
    psOutput = execSync("ps -ww -eo pid,command 2>/dev/null || ps -eo pid,args 2>/dev/null", {
      encoding: "utf8",
    });
  } catch {
    return { pid: null, csrf: null };
  }

  let pid: number | null = null;
  let csrf: string | null = null;

  for (const line of psOutput.split("\n")) {
    if (line.includes("language_server") && line.includes("--csrf_token")) {
      const parts = line.trim().split(/\s+/);
      const parsedPid = parseInt(parts[0], 10);
      if (!Number.isNaN(parsedPid)) {
        pid = parsedPid;
        const match = line.match(/--csrf_token\s+([^\s]+)/);
        if (match) csrf = match[1];
        break;
      }
    }
  }

  return { pid, csrf };
}

function findListeningPorts(pid: number): number[] {
  const ports: number[] = [];
  try {
    const lsof = execSync(`lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`, {
      encoding: "utf8",
    });
    for (const line of lsof.split("\n")) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) {
        const port = parseInt(match[1], 10);
        if (!ports.includes(port)) ports.push(port);
      }
    }
  } catch {}

  if (ports.length === 0) {
    try {
      const ss = execSync(`ss -tlnp 2>/dev/null | grep "pid=${pid},"`, {
        encoding: "utf8",
      });
      for (const line of ss.split("\n")) {
        const match = line.match(/:(\d+)\s+/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (!ports.includes(port)) ports.push(port);
        }
      }
    } catch {}
  }

  return ports;
}

function queryRpc(
  port: number,
  rpcPath: string,
  csrf: string,
  useHttps: boolean,
  timeoutMs = 4000,
): Promise<any> {
  const mod = useHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: "127.0.0.1",
        port,
        path: rpcPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": csrf,
        },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Timeout"));
    });
    req.write(JSON.stringify({}));
    req.end();
  });
}

function getStoredAccountEmail(): string | null {
  try {
    const acctFile = path.join(os.homedir(), ".gemini", "google_accounts.json");
    if (fs.existsSync(acctFile)) {
      const data = JSON.parse(fs.readFileSync(acctFile, "utf8"));
      if (typeof data.active === "string" && data.active.trim()) {
        return data.active.trim();
      }
    }
  } catch {}
  return null;
}

export async function probeQuota(): Promise<QuotaResult> {
  const { pid, csrf } = findDaemon();
  const storedEmail = getStoredAccountEmail();

  if (!pid || !csrf) {
    if (storedEmail) {
      return {
        ok: false,
        error: "Antigravity language server is not running.",
        accountEmail: storedEmail,
        planLabel: null,
        windows: [],
      };
    }
    return {
      ok: false,
      error: "not_installed",
      accountEmail: null,
      planLabel: null,
      windows: [],
    };
  }

  const ports = findListeningPorts(pid);
  if (ports.length === 0) {
    return {
      ok: false,
      error: "Could not find listening port for Antigravity daemon.",
      accountEmail: storedEmail,
      planLabel: null,
      windows: [],
    };
  }

  let quotaSummary: any = null;
  let userStatus: any = null;

  for (const port of ports) {
    for (const useHttps of [false, true]) {
      try {
        quotaSummary = await queryRpc(
          port,
          "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
          csrf,
          useHttps,
        );
        try {
          userStatus = await queryRpc(
            port,
            "/exa.language_server_pb.LanguageServerService/GetUserStatus",
            csrf,
            useHttps,
          );
        } catch {}
        break;
      } catch {}
    }
    if (quotaSummary) break;
  }

  if (!quotaSummary) {
    return {
      ok: false,
      error: "Failed to query Antigravity language server.",
      accountEmail: storedEmail,
      planLabel: null,
      windows: [],
    };
  }

  const accountEmail =
    userStatus?.userStatus?.email ||
    storedEmail ||
    null;

  const rawTier =
    userStatus?.userStatus?.userTier?.name ||
    userStatus?.userStatus?.planStatus?.planInfo?.teamsTier ||
    "";
  let planLabel = "Pro";
  if (rawTier.includes("Ultra")) planLabel = "Ultra";
  else if (rawTier.includes("Pro")) planLabel = "Pro";
  else if (rawTier.includes("Free")) planLabel = "Free";

  const windows: QuotaWindow[] = [];
  const groups = quotaSummary.response?.groups || [];

  for (const g of groups) {
    const isGemini = /gemini/i.test(g.displayName || "");
    const is3p = /claude|gpt|3p/i.test(g.displayName || "");
    const modelName = isGemini ? "Gemini" : is3p ? "Claude" : (g.displayName || "Model");

    for (const b of g.buckets || []) {
      const isWeekly = b.window === "weekly" || /weekly/i.test(b.bucketId || "");
      const is5h = b.window === "5h" || /5h/i.test(b.bucketId || "");
      const windowPrefix = is5h ? "5h" : isWeekly ? "7d" : b.window || "Quota";
      const label = `${windowPrefix} · ${modelName}`;
      const fraction = typeof b.remainingFraction === "number" ? b.remainingFraction : 1;
      const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));

      windows.push({
        id: b.bucketId || `${g.displayName}:${windowPrefix}`,
        kind: "custom",
        label,
        usedPercent,
        resetsAt: b.resetTime || null,
        model: modelName.toLowerCase(),
      });
    }
  }

  return {
    ok: true,
    error: null,
    accountEmail,
    planLabel,
    windows,
  };
}
