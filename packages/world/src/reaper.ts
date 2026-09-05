import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readLedger, rewriteLedger, type LedgerEntry } from "./ledger.ts";

export type ExecFn = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ReapOutcome =
  | { status: "reaped" }
  | { status: "missing" }
  | { status: "skipped"; reason: string };

export interface ReapContext {
  cwd: string;
  exec: ExecFn;
  allowedTmpRoots: string[];
}

export type Reaper = (entry: LedgerEntry, context: ReapContext) => Promise<ReapOutcome>;

export interface ReapReport {
  reaped: LedgerEntry[];
  missing: LedgerEntry[];
  skipped: Array<{ entry: LedgerEntry; reason: string }>;
  retained: LedgerEntry[];
}

export interface ReapOptions {
  cwd: string;
  purge?: boolean;
  reapers?: Record<string, Reaper>;
  exec?: ExecFn;
  allowedTmpRoots?: string[];
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

const defaultExec: ExecFn = (command, args, timeoutMs) => new Promise((done) => {
  execFile(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (!error) {
      done({ code: 0, stdout, stderr });
      return;
    }
    const code = errorCode(error);
    const timedOut = "killed" in error && error.killed === true;
    done({
      code: timedOut ? 124 : code === "ENOENT" ? 127 : typeof code === "number" ? code : 1,
      stdout,
      stderr,
    });
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return !processAlive(pid);
}

const processReaper: Reaper = async (entry, context) => {
  if (entry.id.length === 0) return { status: "skipped", reason: "invalid pid" };
  for (const character of entry.id) {
    const code = character.charCodeAt(0);
    if (code < 48 || code > 57) return { status: "skipped", reason: "invalid pid" };
  }
  const pid = Number(entry.id);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "skipped", reason: "invalid pid" };
  if (!processAlive(pid)) return { status: "missing" };
  if (entry.match === undefined || entry.match.length === 0) {
    return { status: "skipped", reason: "no identity marker" };
  }
  const command = await context.exec("ps", ["-p", String(pid), "-o", "command="], 5_000);
  if (!command.stdout.includes(entry.match)) {
    return { status: "skipped", reason: "identity mismatch" };
  }
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { process.kill(pid, "SIGTERM"); } catch {}
  if (await waitForProcessExit(pid, 5_000)) return { status: "reaped" };
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
  return await waitForProcessExit(pid, 2_000)
    ? { status: "reaped" }
    : { status: "skipped", reason: "still alive" };
};

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

const dockerReaper: Reaper = async (entry, context) => {
  const result = await context.exec("docker", ["rm", "--force", "--volumes", entry.id], 20_000);
  if (result.code === 0) return { status: "reaped" };
  if (result.stderr.includes("No such container")) return { status: "missing" };
  return { status: "skipped", reason: `docker rm failed: ${firstLine(result.stderr)}` };
};

const dockerVolumeReaper: Reaper = async (entry, context) => {
  const result = await context.exec("docker", ["volume", "rm", "--force", entry.id], 20_000);
  if (result.code === 0) return { status: "reaped" };
  if (result.stderr.includes("No such volume")) return { status: "missing" };
  return { status: "skipped", reason: `docker volume rm failed: ${firstLine(result.stderr)}` };
};

async function canonicalPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      const existing = await realpath(candidate);
      return resolve(existing, ...suffix.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(relative(parent, candidate));
      candidate = parent;
    }
  }
}

function belowRoot(path: string, root: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

const tmpdirReaper: Reaper = async (entry, context) => {
  if (!isAbsolute(entry.id)) return { status: "skipped", reason: "outside allowed roots" };
  const canonical = await canonicalPath(entry.id);
  if (!context.allowedTmpRoots.some((root) => belowRoot(canonical, root))) {
    return { status: "skipped", reason: "outside allowed roots" };
  }
  if (!await pathPresent(entry.id)) return { status: "missing" };
  await rm(entry.id, { recursive: true, force: true });
  return { status: "reaped" };
};

export const builtinReapers: Record<string, Reaper> = {
  process: processReaper,
  docker: dockerReaper,
  "docker-volume": dockerVolumeReaper,
  tmpdir: tmpdirReaper,
};

async function existingRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function allowedTmpRoots(options: ReapOptions): Promise<string[]> {
  if (options.allowedTmpRoots) {
    return Promise.all(options.allowedTmpRoots.map((root) => canonicalPath(root)));
  }
  const systemRoots = await Promise.all(
    [tmpdir(), "/tmp", "/private/tmp"].map((root) => existingRealpath(root)),
  );
  const workspaceRoot = await canonicalPath(join(options.cwd, "evals", "results"));
  return [...new Set([...systemRoots.filter((root) => root !== undefined), workspaceRoot])];
}

export async function reapLedger(path: string, options: ReapOptions): Promise<ReapReport> {
  const report: ReapReport = { reaped: [], missing: [], skipped: [], retained: [] };
  const context: ReapContext = {
    cwd: options.cwd,
    exec: options.exec ?? defaultExec,
    allowedTmpRoots: await allowedTmpRoots(options),
  };
  for (const entry of await readLedger(path)) {
    if (entry.retain === true && options.purge !== true) {
      report.retained.push(entry);
      continue;
    }
    const reaper = options.reapers?.[entry.kind] ?? builtinReapers[entry.kind];
    if (!reaper) {
      report.skipped.push({ entry, reason: "no reaper for kind" });
      continue;
    }
    const outcome = await reaper(entry, context);
    if (outcome.status === "reaped") report.reaped.push(entry);
    else if (outcome.status === "missing") report.missing.push(entry);
    else report.skipped.push({ entry, reason: outcome.reason });
  }
  await rewriteLedger(path, [
    ...report.retained,
    ...report.skipped.map(({ entry }) => entry),
  ]);
  return report;
}
