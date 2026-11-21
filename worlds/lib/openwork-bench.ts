import { readFile } from "node:fs/promises";
import { checkedExec, defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { OPENWORK_BENCH_REPO, OPENWORK_BENCH_REVISION } from "../../evals/worlds/openwork-bench-source.ts";
import { output } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";
import { ENV_NAMES } from "./openwork-bench-guest.mjs";

/** uv release the sandbox installs when it has none. */
export const UV_VERSION = "0.12.7";
/** The Freestyle desktop snapshot serves Electron's CDP here (packages/world-freestyle/src/desktop.mjs). */
export const FREESTYLE_DESKTOP_CDP_PORT = 9825;
const SHA = /^[0-9a-f]{40}$/;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface BenchWorldOptions {
  benchRef: string;
  lifetimeMinutes: number;
}

/** Script arguments after `--`. A finite lifetime is required: the sandbox is deleted when it ends. */
export function parseBenchWorldOptions(argv: readonly string[]): BenchWorldOptions {
  let benchRef = OPENWORK_BENCH_REVISION;
  let lifetimeMinutes = 240;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === "--bench-ref" && value !== undefined && SHA.test(value)) {
      benchRef = value;
    } else if (argv[i] === "--lifetime" && value !== undefined && /^\d+$/.test(value) && Number(value) >= 10 && Number(value) <= 1430) {
      lifetimeMinutes = Number(value);
    } else {
      throw new Error("Use --bench-ref <full 40-character openwork-bench commit> and --lifetime <10-1430 minutes>.");
    }
  }
  return { benchRef, lifetimeMinutes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * One bash script, run as the sandbox user, that installs `owb` with uv at a
 * pinned revision, checks out the same revision's task files (the wheel has
 * none), and writes the desktop server's address and tokens to an env file.
 * Its only stdout is the guest's JSON report; tool output goes to stderr.
 */
export function benchInstallScript(input: { benchRef: string; cdpPort: number; guestScript: string }): string {
  if (!SHA.test(input.benchRef)) throw new Error("The openwork-bench revision must be a full 40-character commit SHA.");
  if (!Number.isInteger(input.cdpPort) || input.cdpPort <= 0) throw new Error("The desktop CDP port must be a positive integer.");
  const guest = Buffer.from(input.guestScript, "utf8").toString("base64");
  return [
    "set -euo pipefail",
    'dir="$HOME/openwork-bench"',
    'mkdir -p "$dir/workspaces" && chmod 700 "$dir"',
    'export PATH="$HOME/.local/bin:$PATH"',
    `command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_NO_MODIFY_PATH=1 sh >&2`,
    `uv tool install --force --python 3.13 ${shellQuote(`openwork-bench[all] @ git+${OPENWORK_BENCH_REPO}@${input.benchRef}`)} >&2`,
    'rm -rf "$dir/repo" && git init -q "$dir/repo"',
    `git -C "$dir/repo" fetch -q --depth 1 ${OPENWORK_BENCH_REPO} ${input.benchRef}`,
    'git -C "$dir/repo" checkout -q --detach FETCH_HEAD',
    `[[ "$(owb run --help)" == *--openwork-url* ]] || { echo "openwork-bench ${input.benchRef} has no openwork-desktop harness; pass a newer --bench-ref." >&2; exit 1; }`,
    `printf %s ${guest} | base64 -d > "$dir/openwork-bench-guest.mjs"`,
    `node "$dir/openwork-bench-guest.mjs" ${input.cdpPort} "$dir/openwork.env" "$dir/repo/tasks"`,
  ].join("\n");
}

export interface BenchGuestReport {
  openworkUrl: string;
  envFile: string;
}

/** The guest's last stdout line: the server address and env file path, never a token. */
export function parseBenchGuestReport(stdout: string): BenchGuestReport {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("OpenWork Bench setup did not report the desktop server."); }
  if (!isRecord(value)) throw new Error("OpenWork Bench setup report is not an object.");
  const { openworkUrl, envFile, names } = value;
  if (typeof openworkUrl !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(openworkUrl)) {
    throw new Error("The desktop's OpenWork server must be a loopback http address inside the sandbox.");
  }
  if (typeof envFile !== "string" || !envFile.startsWith("/")) throw new Error("OpenWork Bench setup did not report its env file.");
  if (!Array.isArray(names) || names.join() !== ENV_NAMES.join()) throw new Error("OpenWork Bench env file does not define the expected names.");
  return { openworkUrl, envFile };
}

/** Where the install runs: the desktop's own sandbox or VM. */
export interface BenchGuest {
  cdpPort: number;
  run(script: string, timeoutMs: number): Promise<string>;
}

export function daytonaBenchGuest(sandbox: string, cdpPort: number): BenchGuest {
  return {
    cdpPort,
    run: async (script, timeoutMs) => {
      const result = await checkedExec(defaultDaytonaExec, ["exec", sandbox, "--", `bash -lc ${shellQuote(script)}`], "Install OpenWork Bench in the desktop sandbox", { timeoutMs });
      return result.stdout;
    },
  };
}

export async function freestyleBenchGuest(vmId: string): Promise<BenchGuest> {
  const { client, guestCommandOutcome } = await import("../../packages/world-freestyle/src/index.ts");
  const vm = client().vms.ref(vmId);
  return {
    cdpPort: FREESTYLE_DESKTOP_CDP_PORT,
    run: async (script, timeoutMs) => {
      const result = await vm.exec({ command: `bash -lc ${shellQuote(script)}`, timeoutMs, linuxUser: "root" });
      if (result.statusCode !== 0) {
        throw new Error(`Install OpenWork Bench in the Freestyle desktop failed (${guestCommandOutcome(result.statusCode, timeoutMs)}):\n${(result.stderr ?? "").slice(-2_000)}`);
      }
      return result.stdout ?? "";
    },
  };
}

/** Install the benchmark next to the desktop and describe how to run it. Outputs carry names and paths only. */
export async function installBench(guest: BenchGuest, benchRef: string): Promise<Record<string, WorldOutput>> {
  const guestScript = await readFile(new URL("./openwork-bench-guest.mjs", import.meta.url), "utf8");
  const report = parseBenchGuestReport(await guest.run(benchInstallScript({ benchRef, cdpPort: guest.cdpPort, guestScript }), INSTALL_TIMEOUT_MS));
  const home = report.envFile.replace(/\/openwork\.env$/, "");
  const group = "OpenWork Bench";
  return {
    openworkUrl: output(report.openworkUrl, { group, note: "The desktop's own OpenWork server, reachable inside the sandbox" }),
    benchEnv: output(report.envFile, { group, note: `Defines ${ENV_NAMES.join(", ")}; readable only inside the sandbox, never printed` }),
    tokenEnv: output("OPENWORK_TOKEN", { group, note: "Client token for workspace routes" }),
    hostTokenEnv: output("OPENWORK_HOST_TOKEN", { group, note: "Host token for creating workspaces" }),
    benchRef: output(benchRef, { group, note: "openwork-bench revision installed with uv; its tasks are in OWB_TASKS_DIR" }),
    benchRun: output(`source ${report.envFile} && owb run <model>@openwork-desktop --openwork-url "$OPENWORK_URL" --workspace-root ${home}/workspaces`, {
      group, note: "Run inside the sandbox with a dedicated, capped model key; price it first with owb world plan",
    }),
  };
}
