import {
  daytonaSandbox,
  defaultDaytonaExec,
  execInSandbox,
  retainedDesktop,
} from "@openwork/hosts";
import type { ElectronStartupObservation } from "@openwork/hosts";

export interface PublishedDesktopSandboxWitnessOptions {
  sandboxId: string;
  pid: string;
  archivePath: string;
  bootstrapPath: string;
  protocolHandlerPath: string;
  shortcutPaths: readonly string[];
  environmentKeys: readonly string[];
  dispatchDeepLink?: boolean;
}

export interface PublishedDesktopSandboxWitness {
  archiveSha256: string;
  executablePath: string;
  workingDirectory: string;
  bootstrapExists: boolean;
  environment: Record<string, string>;
  unexpectedSensitiveEnvironmentKeys: string[];
  protocolHandler: string;
  defaultProtocolHandler: string;
  shortcutsExecutable: boolean[];
  handoffExitCode: number | null;
  primaryProcessAlive: boolean;
}

export interface RetainedCrashedDesktopWitness extends AsyncDisposable {
  startup: ElectronStartupObservation;
  stop(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Published desktop witness returned invalid ${key}.`);
  return field;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!record(value)) throw new Error("Published desktop witness returned an invalid environment.");
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") throw new Error(`Published desktop witness returned an invalid ${key} environment value.`);
    result[key] = field;
  }
  return result;
}

/** Read only release-integrity fields and explicitly named process environment values from a Daytona sandbox. */
export async function readPublishedDesktopSandboxWitness(
  options: PublishedDesktopSandboxWitnessOptions,
): Promise<PublishedDesktopSandboxWitness> {
  const payload = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  const source = `
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import time

request = json.loads(base64.b64decode("${payload}"))
pid = str(int(request["pid"]))
process_root = pathlib.Path("/proc") / pid
allowed = set(request["environmentKeys"])
environment = {}
environment_names = []
for entry in (process_root / "environ").read_bytes().split(b"\\0"):
    key_bytes, separator, value_bytes = entry.partition(b"=")
    if not separator:
        continue
    key = key_bytes.decode("utf-8", errors="replace")
    environment_names.append(key)
    if key in allowed:
        environment[key] = value_bytes.decode("utf-8", errors="replace")

sensitive_markers = ("API_KEY", "ACCESS_KEY", "CREDENTIAL", "PASSWORD", "PRIVATE_KEY", "SECRET", "TOKEN")
source_overrides = {"OPENWORK_ELECTRON_BINARY", "OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", "OPENWORK_WORKSPACE_DIR", "VITE_DEV_SERVER_URL"}
unexpected_sensitive = sorted({
    key for key in environment_names
    if key in source_overrides or (key not in allowed and any(marker in key for marker in sensitive_markers))
})

digest = hashlib.sha256()
with pathlib.Path(request["archivePath"]).open("rb") as archive:
    for chunk in iter(lambda: archive.read(1024 * 1024), b""):
        digest.update(chunk)

xdg_environment = {
    key: value for key, value in environment.items()
    if key in {"DISPLAY", "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"}
}
xdg_environment["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
xdg_environment["LANG"] = "C.UTF-8"
xdg_environment["XDG_CURRENT_DESKTOP"] = "XFCE"
xdg_environment["DESKTOP_SESSION"] = "xfce"
handler = subprocess.run(
    ["xdg-mime", "query", "default", "x-scheme-handler/openwork"],
    check=False,
    capture_output=True,
    text=True,
    timeout=30,
    env=xdg_environment,
)
handoff_exit_code = None
if request.get("dispatchDeepLink", False):
    handoff = subprocess.run(
        ["xdg-open", "openwork://open"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
        env=xdg_environment,
    )
    handoff_exit_code = handoff.returncode
    time.sleep(2)

result = {
    "archiveSha256": digest.hexdigest(),
    "executablePath": os.readlink(process_root / "exe"),
    "workingDirectory": os.readlink(process_root / "cwd"),
    "bootstrapExists": pathlib.Path(request["bootstrapPath"]).exists(),
    "environment": environment,
    "unexpectedSensitiveEnvironmentKeys": unexpected_sensitive,
    "protocolHandler": pathlib.Path(request["protocolHandlerPath"]).read_text(encoding="utf-8"),
    "defaultProtocolHandler": handler.stdout.strip() if handler.returncode == 0 else "",
    "shortcutsExecutable": [pathlib.Path(path).is_file() and os.access(path, os.X_OK) for path in request["shortcutPaths"]],
    "handoffExitCode": handoff_exit_code,
    "primaryProcessAlive": process_root.exists(),
}
print(json.dumps(result))
`.trim();
  const encodedSource = Buffer.from(source, "utf8").toString("base64");
  const result = await execInSandbox(
    defaultDaytonaExec,
    options.sandboxId,
    `printf %s ${encodedSource} | base64 -d | python3`,
    { timeoutMs: 90_000, context: "published desktop sandbox witness" },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Published desktop witness returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record(parsed)) throw new Error("Published desktop witness returned a non-object result.");
  const sensitive = parsed.unexpectedSensitiveEnvironmentKeys;
  const shortcuts = parsed.shortcutsExecutable;
  const handoffExitCode = parsed.handoffExitCode;
  if (!Array.isArray(sensitive) || !sensitive.every((key) => typeof key === "string")) {
    throw new Error("Published desktop witness returned invalid sensitive environment keys.");
  }
  if (!Array.isArray(shortcuts) || !shortcuts.every((ready) => typeof ready === "boolean")) {
    throw new Error("Published desktop witness returned invalid shortcut readiness.");
  }
  if (handoffExitCode !== null && typeof handoffExitCode !== "number") {
    throw new Error("Published desktop witness returned an invalid deep-link exit code.");
  }
  if (typeof parsed.bootstrapExists !== "boolean" || typeof parsed.primaryProcessAlive !== "boolean") {
    throw new Error("Published desktop witness returned invalid process state.");
  }
  return {
    archiveSha256: stringField(parsed, "archiveSha256"),
    executablePath: stringField(parsed, "executablePath"),
    workingDirectory: stringField(parsed, "workingDirectory"),
    bootstrapExists: parsed.bootstrapExists,
    environment: stringRecord(parsed.environment),
    unexpectedSensitiveEnvironmentKeys: sensitive,
    protocolHandler: stringField(parsed, "protocolHandler"),
    defaultProtocolHandler: stringField(parsed, "defaultProtocolHandler"),
    shortcutsExecutable: shortcuts,
    handoffExitCode,
    primaryProcessAlive: parsed.primaryProcessAlive,
  };
}

/** Launch a known-negative binary without exposing host construction to journey specs. */
export async function retainedCrashedDesktopWitness(sandboxId: string): Promise<RetainedCrashedDesktopWitness> {
  const host = daytonaSandbox(sandboxId);
  try {
    const desktop = await retainedDesktop({
      host,
      name: "release-crash-proof",
      binaryPath: "/bin/false",
      startupTimeoutMs: 3_000,
    });
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await desktop.stop();
      } finally {
        await host[Symbol.asyncDispose]();
      }
    };
    return {
      startup: desktop.startup,
      stop,
      [Symbol.asyncDispose]: () => stop(),
    };
  } catch (error) {
    try {
      await host[Symbol.asyncDispose]();
    } catch {}
    throw error;
  }
}
