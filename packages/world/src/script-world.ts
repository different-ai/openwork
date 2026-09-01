import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LEDGER_ENV, ledgerPath } from "./ledger.ts";
import { receiptName } from "./stage.ts";
import { assertWorldName } from "./store.ts";
import type { ScriptWorldSnapshot } from "./hold.ts";

const DEFAULT_START_TIMEOUT_MS = 10 * 60 * 1_000;
const DOWN_TIMEOUT_MS = 60 * 1_000;
const POLL_INTERVAL_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function recordedPid(text: string): number | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    return undefined;
  }
  return value.pid;
}

export function parseScriptWorldSnapshot(text: string): ScriptWorldSnapshot {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || value.kind !== "script"
    || typeof value.name !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.pid !== "number"
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.sourcePath !== "string"
    || !isStringRecord(value.outputs)
    || (value.version === 2 && "stage" in value && value.stage !== undefined && typeof value.stage !== "string")
    || (value.version === 2 && "recipeHash" in value && value.recipeHash !== undefined && typeof value.recipeHash !== "string")
    || (value.version === 2 && "place" in value && value.place !== undefined && typeof value.place !== "string")
  ) {
    throw new Error("The file is not a valid script world snapshot.");
  }
  return {
    version: value.version,
    kind: "script",
    name: value.name,
    createdAt: value.createdAt,
    pid: value.pid,
    sourcePath: value.sourcePath,
    outputs: value.outputs,
    ...(value.version === 2 && typeof value.stage === "string" ? { stage: value.stage } : {}),
    ...(value.version === 2 && typeof value.recipeHash === "string" ? { recipeHash: value.recipeHash } : {}),
    ...(value.version === 2 && typeof value.place === "string" ? { place: value.place } : {}),
  };
}

/** Hashes only the recipe file bytes; imported files are not included. */
export async function computeRecipeHash(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function scriptWorldSnapshotDirectory(repoRoot: string): string {
  return resolve(
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR
      ?? join(repoRoot, "evals", "results", ".worlds", "scripts"),
  );
}

export function scriptWorldSnapshotPath(directory: string, name: string): string {
  assertWorldName(name);
  return join(directory, `${name}.json`);
}

export function scriptWorldLogPath(directory: string, name: string): string {
  assertWorldName(name);
  return join(directory, `${name}.log`);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function readScriptWorldSnapshot(path: string): Promise<ScriptWorldSnapshot | undefined> {
  try {
    return parseScriptWorldSnapshot(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function removeDeadSnapshot(path: string): Promise<void> {
  try {
    const snapshot = await readScriptWorldSnapshot(path);
    if (snapshot && !isProcessAlive(snapshot.pid)) await rm(path, { force: true });
  } catch {
    await rm(path, { force: true });
  }
}

async function assertNoRunningSnapshot(path: string, name: string): Promise<void> {
  let pid: number | undefined;
  try {
    pid = recordedPid(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return;
    await rm(path, { force: true });
    return;
  }
  if (pid !== undefined && isProcessAlive(pid)) {
    throw new Error(
      `Script world ${JSON.stringify(name)} is already running (pid ${pid}); run \`pnpm world down ${name}\` first.`,
    );
  }
  await rm(path, { force: true });
}

async function waitForChild(path: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const ignoreSigint = (): void => {};
  process.on("SIGINT", ignoreSigint);
  try {
    const child = spawn(process.execPath, [path, ...args], { env, stdio: "inherit" });
    return await new Promise<number>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code ?? 1));
    });
  } finally {
    process.off("SIGINT", ignoreSigint);
  }
}

async function lastLogLines(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.trimEnd().split(/\r?\n/).slice(-40);
  } catch {
    return [];
  }
}

export interface LaunchScriptWorldOptions {
  path: string;
  name: string;
  args: readonly string[];
  snapshotDirectory: string;
  detach: boolean;
  timeoutMs?: number;
  stage?: string;
  recipeHash?: string;
  place?: string;
  print: (line: string) => void;
}

export async function launchScriptWorld(options: LaunchScriptWorldOptions): Promise<number> {
  const path = resolve(options.path);
  const stagedName = receiptName(options.name, options.stage);
  const snapshotPath = scriptWorldSnapshotPath(options.snapshotDirectory, stagedName);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENWORK_WORLD_SNAPSHOT_DIR: options.snapshotDirectory,
    [LEDGER_ENV]: ledgerPath(options.snapshotDirectory, stagedName),
  };
  if (options.stage === undefined) delete env.OPENWORK_WORLD_STAGE;
  else env.OPENWORK_WORLD_STAGE = options.stage;
  if (options.recipeHash === undefined) delete env.OPENWORK_WORLD_RECIPE_HASH;
  else env.OPENWORK_WORLD_RECIPE_HASH = options.recipeHash;
  if (options.place === undefined) delete env.OPENWORK_WORLD_PLACE;
  else env.OPENWORK_WORLD_PLACE = options.place;
  await assertNoRunningSnapshot(snapshotPath, stagedName);

  if (!options.detach) return waitForChild(path, options.args, env);

  const logPath = scriptWorldLogPath(options.snapshotDirectory, stagedName);
  await mkdir(options.snapshotDirectory, { recursive: true });
  const log = await open(logPath, "w", 0o600);
  await chmod(logPath, 0o600);
  const child = await (async () => {
    try {
      return spawn(process.execPath, [path, ...options.args], {
        detached: true,
        env,
        stdio: ["ignore", log.fd, log.fd],
      });
    } finally {
      await log.close();
    }
  })();
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const snapshot = await readScriptWorldSnapshot(snapshotPath);
    if (snapshot) {
      for (const [key, value] of Object.entries(snapshot.outputs)) options.print(`${key}  ${value}`);
      options.print(`snapshot  ${snapshotPath}`);
      options.print(`log  ${logPath}`);
      return 0;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await removeDeadSnapshot(snapshotPath);
      options.print(`Script world ${JSON.stringify(stagedName)} exited before creating its snapshot.`);
      for (const line of await lastLogLines(logPath)) options.print(line);
      return 1;
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }

  if (child.pid !== undefined) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    try { process.kill(child.pid, "SIGTERM"); } catch {}
  }
  await removeDeadSnapshot(snapshotPath);
  options.print(`Timed out after ${options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms waiting for script world ${JSON.stringify(stagedName)}.`);
  for (const line of await lastLogLines(logPath)) options.print(line);
  return 1;
}

export interface DownScriptWorldResult {
  found: boolean;
  forced: boolean;
  pid?: number;
}

export async function downScriptWorld(path: string): Promise<DownScriptWorldResult> {
  const snapshot = await readScriptWorldSnapshot(path);
  if (!snapshot) return { found: false, forced: false };

  if (!isProcessAlive(snapshot.pid)) {
    await rm(path, { force: true });
    return { found: true, forced: false, pid: snapshot.pid };
  }

  try {
    process.kill(snapshot.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + DOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!await fileExists(path) && !isProcessAlive(snapshot.pid)) {
      return { found: true, forced: false, pid: snapshot.pid };
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }

  try { process.kill(-snapshot.pid, "SIGKILL"); } catch {}
  try { process.kill(snapshot.pid, "SIGKILL"); } catch {}
  await rm(path, { force: true });
  return { found: true, forced: true, pid: snapshot.pid };
}
