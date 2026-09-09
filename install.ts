// Shared install logic for the Google Antigravity ACP server.
// Runs on the target machine from the host entry, and directly in the server
// process as the server-local fallback.
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DistEntry {
  archive: string;
  cmd: string;
  args?: string[];
}

export type DistMap = Record<string, DistEntry>;

// ACP registry commit this build is pinned to. The registry is fetched from
// this exact commit (never from an unpinned `main`), so someone landing a
// commit on the registry cannot redirect the install to arbitrary binaries.
// Bump this SHA when the plugin is updated to track newer releases.
export const REGISTRY_COMMIT = "81bf71b55e15f630c4fb8a86d20d3088071d2071";
const REGISTRY_URL = `https://raw.githubusercontent.com/agentclientprotocol/registry/${REGISTRY_COMMIT}/antigravity-acp/agent.json`;

// Mirrors the ACP registry entry (agentclientprotocol/registry →
// antigravity-acp → distribution.binary). Used verbatim when the pinned
// registry fetch fails or the entry is missing this platform, so installs
// never depend on a live upstream at install time.
export const FALLBACK_DIST: DistMap = {
  "darwin-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
    cmd: "./agy_acp_server.par",
  },
  "linux-x86_64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
    cmd: "./agy_acp_server.par",
    args: ["--uid="],
  },
  "linux-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip",
    cmd: "./agy_acp_server.par",
    args: ["--uid="],
  },
  "windows-x86_64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip",
    cmd: "./agy_acp_server.exe",
  },
  "windows-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip",
    cmd: "./agy_acp_server.exe",
  },
};

export interface InstallOptions {
  installDir: string;
  binDir: string;
  force: boolean;
  /**
   * Windows only: when true, append binDir to the user PATH via setx
   * (permanent HKCU\Environment mutation) after linking. Defaults to false —
   * prefer an explicit opt-in over a silent persistent PATH edit.
   */
  updatePath?: boolean;
  /** Optional explicit source: a zip URL or a local zip path. Skips the ACP registry lookup. */
  source?: string;
}

export interface InstallResult {
  ok: boolean;
  platform: string;
  arch: string;
  distKey: string;
  url: string;
  args: string[];
  registryCommit: string;
  installDir: string;
  binDir: string;
  binaryPath: string | null;
  harnessPath: string | null;
  alreadyInstalled: boolean;
  error: string | null;
  notes: string[];
}

export interface ProbeResult {
  ok: boolean;
  platform: string;
  arch: string;
  binaryPath: string | null;
  harnessPath: string | null;
  error: string | null;
}

const MANIFEST = ".google-antigravity-acp.json";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  if (p.startsWith("$HOME/")) return join(homedir(), p.slice(6));
  return p;
}

export interface TargetInfo {
  platform: string;
  arch: string;
  distKey: string;
  binaryName: string;
  isWindows: boolean;
}

export function detectTarget(): TargetInfo {
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return {
    platform,
    arch,
    distKey: `${platform}-${arch}`,
    binaryName: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
    isWindows: platform === "win32",
  };
}

export async function fetchDistMap(): Promise<DistMap> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return FALLBACK_DIST;
    const json = (await res.json()) as {
      distribution?: { binary?: Record<string, { archive?: unknown; cmd?: unknown; args?: unknown }> };
    };
    const binary = json.distribution?.binary;
    if (!binary) return FALLBACK_DIST;
    const map: DistMap = {};
    for (const [key, entry] of Object.entries(binary)) {
      if (typeof entry.archive === "string" && typeof entry.cmd === "string") {
        map[key] = {
          archive: entry.archive,
          cmd: entry.cmd,
          args: Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : undefined,
        };
      }
    }
    return Object.keys(map).length > 0 ? map : FALLBACK_DIST;
  } catch {
    return FALLBACK_DIST;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const patterns = process.platform === "win32"
    ? [name, ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => name + ext)]
    : [name];
  for (const dir of dirs) {
    for (const candidate of patterns) {
      try {
        const full = join(dir || ".", candidate);
        const s = await stat(full);
        if (s.isFile()) return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) from ${url}`);
  }
  // fetch returns undici's ReadableStream; Readable.fromWeb wants node's web
  // ReadableStream. Same object at runtime — cast across the declaration gap.
  await pipeline(
    Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    createWriteStream(dest),
  );
}

// Rejects archives whose entries could escape the destination directory.
// Runs before any extraction so no extractor (including tar fallbacks, which
// are deliberately not used) can write outside installDir.
const PYTHON_VALIDATE = String.raw`
import sys, zipfile
path = sys.argv[1]
try:
    zf = zipfile.ZipFile(path)
except Exception as e:
    print(f"not a zip: {e}", file=sys.stderr)
    sys.exit(2)
unsafe = []
for name in zf.namelist():
    if name.startswith(("/", "\\")) or ":" in name.split("/", 1)[0]:
        unsafe.append(name)
        continue
    parts = name.replace("\\", "/").split("/")
    if any(p in ("..", "") for p in parts[:-1]):
        unsafe.append(name)
if unsafe:
    print("unsafe zip entries: " + repr(unsafe[:5]), file=sys.stderr)
    sys.exit(1)
`;

// Python extraction that first applies the same traversal validation and
// then extracts with zipfile (which additionally strips absolute paths).
const PYTHON_EXTRACT = String.raw`
import sys, zipfile
path, dest = sys.argv[1], sys.argv[2]
zf = zipfile.ZipFile(path)
for name in zf.namelist():
    if name.startswith(("/", "\\")) or ":" in name.split("/", 1)[0]:
        print("unsafe zip entry: " + name, file=sys.stderr)
        sys.exit(1)
    parts = name.replace("\\", "/").split("/")
    if any(p in ("..", "") for p in parts[:-1]):
        print("unsafe zip entry: " + name, file=sys.stderr)
        sys.exit(1)
zf.extractall(dest)
`;

async function extractZip(zipPath: string, destDir: string, isWindows: boolean): Promise<void> {
  if (isWindows) {
    // PowerShell's Expand-Archive is backed by .NET's ExtractToDirectory,
    // which rejects entries that escape the destination. No bsdtar here:
    // bsdtar does not sanitize `../` the way Expand-Archive does.
    await execFileAsync(
      "powershell",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { windowsHide: true },
    );
    return;
  }
  // macOS/Linux: prefer Info-ZIP unzip (sanitizes `../`), fall back to a
  // validated python3 zipfile extraction. `tar` is never used: bsdtar does
  // not sanitize `../` entries, and GNU tar cannot read zip archives anyway.
  const attempts: Array<[string, string[]]> = [
    ["unzip", ["-oq", zipPath, "-d", destDir]],
    ["python3", ["-c", PYTHON_EXTRACT, zipPath, destDir]],
  ];
  let lastError: Error | null = null;
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }
  // Last resort: validate entry names, then use python3 zipfile if present.
  try {
    await execFileAsync("python3", ["-c", PYTHON_VALIDATE, zipPath]);
    await execFileAsync("python3", ["-c", PYTHON_EXTRACT, zipPath, destDir]);
    return;
  } catch (err) {
    lastError = err as Error;
  }
  throw lastError ?? new Error(`No safe extractor found for ${zipPath}`);
}

async function helperNameIn(installDir: string, isWindows: boolean): Promise<string | null> {
  const expected = isWindows ? /^localharness[^/\\]*\.exe$/i : /^localharness[^/\\]*$/i;
  const entries = await readdir(installDir).catch(() => [] as string[]);
  return entries.find((name) => expected.test(name)) ?? null;
}

async function ensureLinked(installDir: string, binDir: string, name: string, isWindows: boolean, notes: string[]): Promise<string> {
  const target = join(installDir, name);
  const link = join(binDir, name);
  if (isWindows) {
    await copyFile(target, link);
    return link;
  }
  try {
    await rm(link, { force: true });
    await symlink(target, link);
    return link;
  } catch (err) {
    notes.push(`Symlink ${name} failed in ${binDir}: ${(err as Error).message}. Copied instead.`);
    await copyFile(target, link);
    return link;
  }
}

// Only runs when the user explicitly opts in via --update-path. setx has a
// 1024-character truncation hazard, so over-long combined values are skipped
// with a warning instead of silently corrupting PATH.
async function appendUserPathWindows(binDir: string, updatePath: boolean, notes: string[]): Promise<void> {
  if (!updatePath) {
    notes.push(
      `Not modifying the user PATH. Add ${binDir} to the user PATH manually (or re-run with --update-path).`,
    );
    return;
  }
  try {
    const { stdout } = await execFileAsync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { windowsHide: true });
    const current = stdout.split(/\r?\n/u).find((l) => /^\s*Path\s+REG/i.test(l))?.replace(/^\s*Path\s+REG[A-Z_]*\s+/i, "").trim() ?? "";
    const parts = current.split(";").filter(Boolean);
    if (parts.includes(binDir)) return;
    const next = [...parts, binDir].join(";");
    if (next.length > 1024) {
      notes.push(
        `User PATH would exceed setx's 1024-char limit after adding ${binDir}; skipping the mutation. Add it manually.`,
      );
      return;
    }
    await execFileAsync("setx", ["Path", next], { windowsHide: true });
    notes.push(`Added ${binDir} to the user PATH (setx). Restart the bb daemon so it takes effect.`);
  } catch (err) {
    notes.push(`Could not update the user PATH: ${(err as Error).message}. Add ${binDir} to PATH manually.`);
  }
}

async function writeManifest(
  installDir: string,
  url: string,
  binaryName: string,
  helper: string | null,
  args: string[],
  registryCommit: string,
): Promise<void> {
  await writeFile(
    join(installDir, MANIFEST),
    JSON.stringify({ url, binaryName, helper, args, registryCommit, installedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const notes: string[] = [];
  const target = detectTarget();
  const installDir = expandHome(options.installDir);
  const binDir = expandHome(options.binDir);
  const binaryName = target.binaryName;
  const binaryPath = join(installDir, binaryName);
  const fail = (error: string): InstallResult => ({
    ok: false, platform: target.platform, arch: target.arch, distKey: target.distKey,
    url: "", args: [], registryCommit: REGISTRY_COMMIT, installDir, binDir,
    binaryPath: null, harnessPath: null, alreadyInstalled: false, error, notes,
  });

  const distMap = await fetchDistMap();
  const entry = distMap[target.distKey];
  if (!entry) {
    return fail(
      `No Antigravity ACP distribution for ${target.platform} ${target.arch} in the ACP registry ` +
      `(agentclientprotocol/registry → antigravity-acp). Supported: ${Object.keys(distMap).join(", ")}.`,
    );
  }

  try {
    await mkdir(installDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
  } catch (err) {
    return fail(`Could not create directories: ${(err as Error).message}`);
  }

  // Already installed and not forced: just make sure the links are in place.
  const existing = await stat(binaryPath).catch(() => null);
  if (existing?.isFile() && !options.force) {
    try {
      const helper = await helperNameIn(installDir, target.isWindows);
      const link = await ensureLinked(installDir, binDir, binaryName, target.isWindows, notes);
      if (helper) await ensureLinked(installDir, binDir, helper, target.isWindows, notes);
      notes.push("Binary already present; refreshed symlinks without re-downloading.");
      return {
        ok: true, platform: target.platform, arch: target.arch, distKey: target.distKey, url: entry.archive,
        args: entry.args ?? [], registryCommit: REGISTRY_COMMIT,
        installDir, binDir, binaryPath: link, harnessPath: helper ? join(installDir, helper) : null,
        alreadyInstalled: true, error: null, notes,
      };
    } catch (err) {
      return fail(`Binary exists but links could not be refreshed: ${(err as Error).message}`);
    }
  }

  // Explicit --from only. No environment-variable redirect: an env knob can
  // silently change which archive is downloaded and is easy to forget about.
  const sourceOverride = options.source?.trim();
  let sourceLabel: string;
  try {
    const zipPath = join(tmpdir(), `agy-acp-${Date.now()}.zip`);
    try {
      if (sourceOverride) {
        sourceLabel = sourceOverride;
        if (/^https?:\/\//i.test(sourceOverride)) {
          notes.push(`Downloading ${sourceOverride}`);
          await downloadTo(sourceOverride, zipPath);
        } else {
          notes.push(`Using local archive ${sourceOverride}`);
          await copyFile(sourceOverride, zipPath);
        }
      } else {
        sourceLabel = entry.archive;
        notes.push(`Downloading ${entry.archive}`);
        await downloadTo(entry.archive, zipPath);
      }
      await extractZip(zipPath, installDir, target.isWindows);
    } finally {
      await rm(zipPath, { force: true });
    }
  } catch (err) {
    return fail(`Download or extraction failed: ${(err as Error).message}`);
  }

  const installed = await stat(binaryPath).catch(() => null);
  if (!installed?.isFile()) {
    return fail(`Extraction finished but ${binaryName} was not found in ${installDir}.`);
  }

  try {
    if (!target.isWindows) {
      await chmod(binaryPath, 0o755);
    }
    const helper = await helperNameIn(installDir, target.isWindows);
    if (helper) {
      const full = join(installDir, helper);
      if (!target.isWindows) await chmod(full, 0o755);
      notes.push(`Sandbox helper: ${full}`);
    }
    await writeManifest(installDir, sourceLabel, binaryName, helper, entry.args ?? [], REGISTRY_COMMIT);
  } catch (err) {
    notes.push(`Post-install step failed (continuing): ${(err as Error).message}`);
  }

  const link = await ensureLinked(installDir, binDir, binaryName, target.isWindows, notes).catch((err) => {
    notes.push(`Linking ${binaryName} failed: ${(err as Error).message}`);
    return null;
  });
  const helper = await helperNameIn(installDir, target.isWindows);
  if (link && helper) {
    await ensureLinked(installDir, binDir, helper, target.isWindows, notes).catch((err) => {
      notes.push(`Linking ${helper} failed: ${(err as Error).message}`);
    });
  }
  if (target.isWindows) {
    await appendUserPathWindows(binDir, options.updatePath === true, notes);
  }
  const harnessPath = helper ? join(installDir, helper) : null;

  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  if (!pathDirs.includes(binDir)) {
    notes.push(
      `${binDir} is not on this machine's PATH. Add it, e.g. export PATH="$PATH:${binDir}" in your shell profile.`,
    );
  }

  return {
    ok: true, platform: target.platform, arch: target.arch, distKey: target.distKey, url: sourceLabel,
    args: entry.args ?? [], registryCommit: REGISTRY_COMMIT,
    installDir, binDir, binaryPath: link, harnessPath,
    alreadyInstalled: false, error: null, notes,
  };
}

export async function probeLocal(): Promise<ProbeResult> {
  const target = detectTarget();
  const binaryName = target.binaryName;
  const binaryPath = await findOnPath(binaryName);
  let harnessPath: string | null = null;
  const envHarness = process.env.ANTIGRAVITY_HARNESS_PATH?.trim();
  if (envHarness) {
    harnessPath = envHarness;
  } else {
    const probable = join(homedir(), ".local", "opt", "agy-acp-server");
    const helper = await helperNameIn(probable, target.isWindows).catch(() => null);
    if (helper) {
      const candidate = join(probable, helper);
      if ((await stat(candidate).catch(() => null))?.isFile()) harnessPath = candidate;
    }
    if (!harnessPath) harnessPath = await findOnPath("localharness_external" + (target.isWindows ? ".exe" : ""));
  }
  return {
    ok: binaryPath !== null,
    platform: target.platform,
    arch: target.arch,
    binaryPath,
    harnessPath,
    error: binaryPath ? null : `\`${binaryName}\` was not found on PATH. Install it with \`bb google-antigravity-acp install\`.`,
  };
}
