// bb-plugin-google-antigravity-acp — Google Antigravity as a first-class bb
// agent provider through the official Antigravity ACP server
// (`agy_acp_server.par`).
//
// The provider id is `acp-antigravity` (same family "acp" as the builtin ACP
// agents). Everything agent-specific the bridge needs travels in
// `experimental_bridgeOptions.acpLaunchSpec`; the bridge itself is the
// canonical ACP bridge shipped in host.ts.
import { type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { agyHostContract } from "./contract.js";
import { FALLBACK_DIST, detectTarget, probeLocal, runInstall, type InstallResult } from "./install.js";

const PROVIDER_ID = "acp-antigravity";

export default async function plugin(bb: BbPluginApi) {
  // Where the ACP server lives on target machines. Installs run on each host
  // (`bb google-antigravity-acp install [--machine ...]`), so `~` expands per
  // host. The launch spec sets no env: the server binary and its sandbox
  // helper are linked into binDir on every machine and found via PATH, like
  // bb's builtin ACP agents.
  const settings = bb.settings.define({
    installDir: {
      type: "string",
      label: "Install directory for the ACP server",
      description: "Extracted binaries go here. `~` expands on the target machine.",
      default: "~/.local/opt/agy-acp-server",
    },
    binDir: {
      type: "string",
      label: "Bin directory on PATH",
      description: "Symlinks to the server binary and its sandbox helper go here.",
      default: "~/.local/bin",
    },
  });
  const saved = await settings.get();

  // Launch args come from the ACP registry (mirrored in FALLBACK_DIST): the
  // registry specifies `--uid=` for linux-x86_64/linux-aarch64 only. The
  // launch spec is registered server-side, so platform resolution uses the
  // server's own platform — the common case where bb runs on the same machine
  // that launches the agent. Installs record the per-platform args in their
  // manifest too.
  const launchArgs = FALLBACK_DIST[detectTarget().distKey]?.args ?? [];

  // Immutable launch facts for the ACP server process.
  const LAUNCH = {
    displayName: "Google Antigravity",
    // Found on PATH (install to ~/.local/bin or equivalent). Resolve the
    // platform-specific launch name just like the registry args above;
    // Windows installs `agy_acp_server.exe`, while POSIX uses `.par`. Command
    // and args resolve on the bb server's platform, so a remote agent host on
    // a different OS is not supported by this launch spec (the same limitation
    // the args already had).
    command: detectTarget().binaryName,
    args: launchArgs,
    // Env stays empty on purpose: the ACP server resolves its sandbox helper
    // `localharness_external` from PATH, and `bb google-antigravity-acp
    // install` links both the server binary and the helper into binDir on
    // every machine. A single baked-in ANTIGRAVITY_HARNESS_PATH value would
    // be wrong on every other machine (settings are shared across hosts).
    env: {} as Record<string, string>,
  };

  const host = bb.hosts.experimental_client({ contract: agyHostContract });

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Google Antigravity",
    family: "acp",
    icon: "./icons/google-antigravity.svg",
    strings: {
      // The Antigravity server authenticates in-band (ACP auth requests):
      // oauth-personal (Google account), oauth-business (Gemini Enterprise),
      // gemini-api-key, or agent-platform (ADC/API key).
      signInHint:
        "Open a Google Antigravity thread and follow the login prompt (Google account, Gemini API key, or Agent Platform).",
      expiredHint:
        "Your Google Antigravity session expired. Start a thread and re-authenticate in the login prompt.",
      installUrl: "https://antigravity.google/docs/ide/extensions/zed",
      iconTint: { light: "#4285F4", dark: "#8AB4F8" },
    },
    // Antigravity exposes its effort variants as separate ACP model ids. It
    // does not expose a separate BB service tier or reasoning control.
    reasoningLevels: [{ id: "medium", label: "Medium" }],
    // Only listed on hosts where the ACP server binary is installed and the
    // bridge health probe passes.
    experimental_visibility: "installed",
    // Every ACP agent answers model/list from its own account/agent state, so
    // one probe per machine serves every workspace on it.
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // agy_acp_server.par advertises sessionCapabilities {list, resume}; no
      // session/fork.
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    experimental_nativeSkillRoots: {
      user: [
        ".agents/skills",
        ".gemini/skills",
        ".gemini/config/skills",
        ".gemini/antigravity-cli/skills",
      ],
      project: [
        { path: ".agents/skills", ancestors: true },
        { path: ".gemini/skills", ancestors: true },
      ],
    },
    experimental_bridgeOptions: {
      acpLaunchSpec: LAUNCH,
    },
  });

  bb.cli.register({
    name: "google-antigravity-acp",
    summary: "Inspect and install the Google Antigravity ACP provider",
    commands: [
      {
        name: "status",
        summary: "Show the ACP server binary location and provider id",
        usage: "bb google-antigravity-acp status [--machine <id-or-name>] [--json]",
      },
      {
        name: "install",
        summary:
          "Install the Antigravity ACP server on a machine: downloads the official zip, extracts it, links the binaries onto PATH, sets the sandbox helper path. Windows PATH mutation only with --update-path",
        usage:
          "bb google-antigravity-acp install [--machine <id-or-name>] [--force] [--install-dir <path>] [--bin-dir <path>] [--from <url-or-zip>] [--update-path] [--json]",
      },
    ],
    async run(argv, ctx) {
      const cmd = argv[0];
      if (cmd === "install") return installCmd(bb, argv.slice(1), ctx);
      return statusCmd(bb, argv.slice(1), ctx);
    },
  });

  // ---- commands -----------------------------------------------------------

  async function statusCmd(
    bb: BbPluginApi,
    argv: string[],
    ctx: PluginCliContext,
  ): Promise<{ exitCode: number; stdout: string }> {
    const json = argv.includes("--json");
    const machine = flagValue(argv, "--machine");
    const current = await settings.get();
    const target = await resolveTarget(bb, ctx, machine);
    let probe;
    if (target.hostId && !target.error) {
      try {
        probe = await host.call("probe", null, { hostId: target.hostId, signal: ctx.signal });
      } catch (err) {
        probe = { ok: false, platform: "", arch: "", binaryPath: null, harnessPath: null, error: (err as Error).message };
      }
    } else {
      probe = await probeLocal();
    }
    const status = {
      providerId: PROVIDER_ID,
      displayName: LAUNCH.displayName,
      command: LAUNCH.command,
      launchArgs: LAUNCH.args,
      target: target.hostId
        ? `${target.label}${probe.ok ? "" : " (probe failed)"}`
        : target.error ?? "this machine (server)",
      platform: [probe.platform, probe.arch].filter(Boolean).join(" ") || "unknown",
      installDir: current.installDir,
      binDir: current.binDir,
      harnessPath: probe.harnessPath,
      resolvedBinary: probe.binaryPath,
      ready: probe.ok,
      hint:
        probe.ok
          ? "Ready. The provider appears in `bb provider list` when the bridge health probe passes."
          : probe.error ?? "Not installed. Run `bb google-antigravity-acp install`.",
    };
    return {
      exitCode: 0,
      stdout: json ? JSON.stringify(status) : [
        `providerId:    ${status.providerId}`,
        `displayName:   ${status.displayName}`,
        `command:       ${status.command}`,
        `launchArgs:    ${status.launchArgs.length ? status.launchArgs.join(" ") : "(none)"}`,
        `target:        ${status.target}`,
        `platform:      ${status.platform}`,
        `binary:        ${status.resolvedBinary ?? "NOT FOUND"}`,
        `harnessPath:   ${status.harnessPath ?? "NOT FOUND"}`,
        `installDir:    ${status.installDir}`,
        `binDir:        ${status.binDir}`,
        "",
        status.hint,
      ].join("\n"),
    };
  }

  async function installCmd(
    bb: BbPluginApi,
    argv: string[],
    ctx: PluginCliContext,
  ): Promise<{ exitCode: number; stdout: string; stderr?: string }> {
    const json = argv.includes("--json");
    const force = argv.includes("--force");
    const updatePath = argv.includes("--update-path");
    const machine = flagValue(argv, "--machine");
    const installDirFlag = flagValue(argv, "--install-dir");
    const binDirFlag = flagValue(argv, "--bin-dir");
    const source = flagValue(argv, "--from");
    const current = await settings.get();
    const installDir = installDirFlag ?? (current.installDir?.trim() || "~/.local/opt/agy-acp-server");
    const binDir = binDirFlag ?? (current.binDir?.trim() || "~/.local/bin");

    const target = await resolveTarget(bb, ctx, machine);
    if (target.error) return finish(json, null, target.error);

    let result: InstallResult;
    let where: string;
    try {
      if (target.hostId) {
        where = `${target.label} (${target.hostId})`;
        result = await host.call(
          "install",
          { installDir, binDir, force, updatePath, source },
          { hostId: target.hostId, signal: ctx.signal },
        );
      } else {
        where = "this machine (server-local)";
        result = await runInstall({ installDir, binDir, force, updatePath, source });
      }
    } catch (err) {
      return finish(json, null, `Install failed: ${(err as Error).message}`);
    }

    if (!result.ok) return finish(json, result, result.error ?? "Install failed");

    const lines = [
      result.alreadyInstalled ? "Already installed — links refreshed." : "Installed.",
      `target:       ${where}`,
      `platform:     ${result.platform} ${result.arch} (${result.distKey})`,
      `source:       ${result.url}`,
      `installDir:   ${result.installDir}`,
      `binDir:       ${result.binDir}`,
      `binary:       ${result.binaryPath ?? "NOT FOUND"}`,
      `harnessPath:  ${result.harnessPath ?? "NOT FOUND"}`,
      `launchArgs:   ${result.args.length ? result.args.join(" ") : "(none)"}`,
    ];
    for (const note of result.notes) lines.push(`  - ${note}`);
    lines.push("");
    lines.push("Next: `bb google-antigravity-acp status`, then `bb provider list` (the provider appears once the health probe passes).");

    return finish(json, result, null, lines.join("\n"));
  }
}

// ---- helpers --------------------------------------------------------------

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function resolveTarget(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  machine: string | undefined,
): Promise<{ hostId: string | null; label: string; error?: string }> {
  if (machine) {
    const hosts = await bb.sdk.hosts.list({ signal: ctx.signal });
    const hit = hosts.find((h) => h.id === machine || h.name === machine);
    if (!hit) return { hostId: null, label: "", error: `Machine '${machine}' not found. See \`bb machine list\`.` };
    return { hostId: hit.id, label: hit.name };
  }
  if (ctx.threadId) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
      if (thread.environmentId) {
        const env = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal: ctx.signal });
        return { hostId: env.hostId, label: `environment ${thread.environmentId} on ${env.hostId}` };
      }
    } catch {
      // fall through to server-local
    }
  }
  return { hostId: null, label: "this machine (server)" };
}

function finish(
  json: boolean,
  result: InstallResult | null,
  error: string | null,
  text?: string,
): { exitCode: number; stdout: string } {
  if (json) {
    return { exitCode: error ? 1 : 0, stdout: JSON.stringify({ ok: !error, error, result }) };
  }
  return { exitCode: error ? 1 : 0, stdout: error ?? text ?? "" };
}
