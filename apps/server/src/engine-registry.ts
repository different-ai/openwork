import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { runtimeStorageDir } from "./runtime-db.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

export type EngineInstanceRole = "starting" | "primary" | "draining";

export type EngineInstanceRecord = {
  id: string;
  pid: number;
  port: number;
  url: string;
  startedAt: number;
  role: EngineInstanceRole;
  serverRunId: string;
  ownerPid: number;
  authProbe: string;
  bin: string;
};

type EngineRegistryFile = {
  version: 1;
  entries: EngineInstanceRecord[];
};

export type EngineReapResult = {
  killed: number[];
  spared: number[];
  dropped: number[];
};

type EngineRegistryLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

export function engineRegistryFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "engine-instances.json");
}

export function buildEngineAuthProbeHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): EngineInstanceRecord | null {
  if (!isRecord(value)) return null;
  const pid = Number(value.pid);
  const port = Number(value.port);
  const ownerPid = Number(value.ownerPid);
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (typeof value.url !== "string" || !value.url.trim()) return null;
  const role = value.role === "primary" || value.role === "draining" || value.role === "starting"
    ? value.role
    : "primary";
  return {
    id: value.id,
    pid,
    port,
    url: value.url,
    startedAt: Number(value.startedAt) || 0,
    role,
    serverRunId: typeof value.serverRunId === "string" ? value.serverRunId : "",
    ownerPid,
    authProbe: typeof value.authProbe === "string" ? value.authProbe : "",
    bin: typeof value.bin === "string" ? value.bin : "",
  };
}

async function readRegistryFile(path: string): Promise<EngineInstanceRecord[]> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map(parseEntry)
      .filter((entry): entry is EngineInstanceRecord => entry !== null);
  } catch {
    return [];
  }
}

const registryWriteQueue = new Map<string, Promise<unknown>>();

async function mutateRegistry(
  config: ServerConfig,
  mutate: (entries: EngineInstanceRecord[]) => EngineInstanceRecord[],
): Promise<EngineInstanceRecord[]> {
  const path = engineRegistryFilePath(config);
  const job = async (): Promise<EngineInstanceRecord[]> => {
    const entries = mutate(await readRegistryFile(path));
    const payload: EngineRegistryFile = { version: 1, entries };
    await mkdir(runtimeStorageDir(config), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path).catch(async (error) => {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    });
    return entries;
  };
  const previous = registryWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  registryWriteQueue.set(path, next);
  return await next;
}

export async function readEngineRegistry(config: ServerConfig): Promise<EngineInstanceRecord[]> {
  return readRegistryFile(engineRegistryFilePath(config));
}

export async function registerEngineInstance(
  config: ServerConfig,
  record: EngineInstanceRecord,
): Promise<void> {
  await mutateRegistry(config, (entries) => [
    ...entries.filter((entry) => entry.id !== record.id),
    record,
  ]);
}

export async function updateEngineInstanceRole(
  config: ServerConfig,
  id: string,
  role: EngineInstanceRole,
): Promise<void> {
  await mutateRegistry(config, (entries) =>
    entries.map((entry) => (entry.id === id ? { ...entry, role } : entry)),
  );
}

export async function removeEngineInstance(config: ServerConfig, id: string): Promise<void> {
  await mutateRegistry(config, (entries) => entries.filter((entry) => entry.id !== id));
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processCommand(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      if (result.status !== 0) return null;
      const row = String(result.stdout ?? "").split(/\r?\n/).find((line) => line.includes(`"${pid}"`));
      if (!row) return null;
      const command = row.split('","')[0]?.replace(/^"/, "");
      return command?.trim() || null;
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const command = String(result.stdout ?? "").trim();
    return command || null;
  } catch {
    return null;
  }
}

function commandMatchesEngine(command: string, bin: string): boolean {
  const lower = command.toLowerCase();
  if (/(^|[/\\ ])opencode[^/\\ ]*( |$)/.test(lower) && lower.includes("serve")) return true;
  const binBase = basename(bin.trim()).toLowerCase();
  return binBase.length > 0 && lower.includes(binBase);
}

type ProbeOutcome = "ours" | "stranger" | "unreachable";

async function probeEngineIdentity(entry: EngineInstanceRecord, timeoutMs: number): Promise<ProbeOutcome> {
  let target: string;
  try {
    target = new URL("/global/health", entry.url).toString();
  } catch {
    return "unreachable";
  }
  try {
    const response = await loopbackFetch(target, {
      headers: entry.authProbe ? { Authorization: entry.authProbe } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return "ours";
    if (response.status === 401 || response.status === 403) return "stranger";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

function killEngineProcess(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reapOrphanEngineInstances(
  config: ServerConfig,
  options?: { logger?: EngineRegistryLogger; probeTimeoutMs?: number; killWaitMs?: number },
): Promise<EngineReapResult> {
  const probeTimeoutMs = options?.probeTimeoutMs ?? 1000;
  const killWaitMs = options?.killWaitMs ?? 1000;
  const result: EngineReapResult = { killed: [], spared: [], dropped: [] };
  const kept: EngineInstanceRecord[] = [];
  const toKill: EngineInstanceRecord[] = [];

  for (const entry of await readEngineRegistry(config)) {
    if (entry.ownerPid === process.pid || processAlive(entry.ownerPid)) {
      kept.push(entry);
      result.spared.push(entry.pid);
      continue;
    }
    if (!processAlive(entry.pid)) {
      result.dropped.push(entry.pid);
      continue;
    }
    const command = processCommand(entry.pid);
    if (command !== null && !commandMatchesEngine(command, entry.bin)) {
      result.dropped.push(entry.pid);
      continue;
    }
    const probe = await probeEngineIdentity(entry, probeTimeoutMs);
    if (probe === "stranger") {
      result.dropped.push(entry.pid);
      continue;
    }
    if (command === null && probe !== "ours") {
      result.dropped.push(entry.pid);
      continue;
    }
    toKill.push(entry);
  }

  for (const entry of toKill) {
    killEngineProcess(entry.pid);
  }
  if (toKill.length > 0 && process.platform !== "win32") {
    await delay(killWaitMs);
    for (const entry of toKill) {
      if (processAlive(entry.pid)) {
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch {
        }
      }
    }
  }
  for (const entry of toKill) {
    result.killed.push(entry.pid);
    options?.logger?.log("info", `Reaped orphaned managed OpenCode engine (pid ${entry.pid}).`, {
      "engine.pid": entry.pid,
      "engine.port": entry.port,
      "engine.owner_pid": entry.ownerPid,
      "engine.role": entry.role,
    });
  }

  await mutateRegistry(config, (entries) => {
    const removed = new Set([...result.killed, ...result.dropped]);
    const surviving = entries.filter((entry) => !removed.has(entry.pid));
    const known = new Set(kept.map((entry) => entry.id));
    return [...kept, ...surviving.filter((entry) => !known.has(entry.id))];
  }).catch(() => undefined);

  return result;
}
