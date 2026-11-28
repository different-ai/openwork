import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { deleteEnv, mergeEnv } from "@openwork/paths";
import { startupPhase } from "./startup-phase.js";
import { randomUUID } from "node:crypto";
import { appendEngineOutputTail, createEngineStartupLineReader } from "./engine-output.js";
import { engineSpawnTimeoutMs } from "./engine-spawn-timeout.js";

export type ManagedChildProcess = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
};

export type ManagedProcessCloseOptions = {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
};

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  execution: OpencodeExecutionSnapshot;
  isAlive: () => boolean;
  close: () => Promise<void>;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

export function createManagedProcessClose(
  child: ManagedChildProcess,
  options: ManagedProcessCloseOptions = {},
): { isAlive: () => boolean; close: () => Promise<void> } {
  let closePromise: Promise<void> | null = null;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const didExit = await Promise.race([exitedPromise.then(() => true), timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return didExit;
  };
  const isAlive = () => !exited && child.exitCode === null && child.signalCode === null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!isAlive()) return;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      if (await waitForExit(options.termTimeoutMs ?? 1_000)) return;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      if (!await waitForExit(options.killTimeoutMs ?? 500)) {
        throw new Error("Managed OpenCode process did not exit after SIGKILL");
      }
    })();
    return closePromise;
  };
  return { isAlive, close };
}

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePortOnce(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

type ManagedOpencodeServerOptions = {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  stateDir?: string;
};

export class ManagedOpencodeExitError extends Error {
  readonly exitCode: number | null;
  readonly addressInUse: boolean;

  constructor(exitCode: number | null, output: string, addressInUse: boolean) {
    super(`OpenCode server exited with code ${exitCode}${addressInUse ? " (EADDRINUSE)" : ""}${output.trim() ? `\n${output}` : ""}`);
    this.exitCode = exitCode;
    this.addressInUse = addressInUse;
  }
}

function isRetryableAddressInUseExit(error: unknown): boolean {
  return error instanceof ManagedOpencodeExitError &&
    error.exitCode === 1 &&
    error.addressInUse;
}

type ForeignStorage = "database" | "config";

const FOREIGN_DATABASE_EXIT = /Database is not empty and has no session table/;
const FOREIGN_CONFIG_EXIT = /Configuration is invalid at (.+?)\s*(?:\n|$)[\s\S]*V2 permissions are not supported by OpenCode V1/;

function globalOpencodeConfigDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config"), "opencode");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function foreignStorageExit(error: unknown, env: NodeJS.ProcessEnv): ForeignStorage | null {
  if (!(error instanceof ManagedOpencodeExitError) || error.exitCode !== 1) return null;
  if (FOREIGN_DATABASE_EXIT.test(error.message)) return "database";
  const config = error.message.match(FOREIGN_CONFIG_EXIT)?.[1]?.trim();
  if (config && isInside(globalOpencodeConfigDir(env), config)) return "config";
  return null;
}

let isolatedDatabase: string | undefined;

export function isolatedOpencodeV1Database(): string | undefined {
  return isolatedDatabase;
}

async function isolatedEngineStorageEnv(stateDir: string, storage: ForeignStorage): Promise<Record<string, string>> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  if (storage === "database") {
    isolatedDatabase = join(stateDir, "opencode.db");
    return { OPENCODE_DB: isolatedDatabase };
  }
  const xdgConfig = join(stateDir, "xdg-config");
  await mkdir(join(xdgConfig, "opencode"), { recursive: true, mode: 0o700 });
  return { XDG_CONFIG_HOME: xdgConfig };
}

async function startManagedOpencodeServer(
  options: ManagedOpencodeServerOptions,
  hostname: string,
  port: number,
): Promise<ManagedOpencodeServer> {
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  const engineEnvDefaults = { npm_config_audit: "false" };
  const env: NodeJS.ProcessEnv = mergeEnv([
    process.env,
    engineEnvDefaults,
    options.env,
    { OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
  ]);
  deleteEnv(env, "OPENWORK_ENCRYPTION_KEY");
  const injectedEnv = Object.entries({
    ...engineEnvDefaults,
    ...(options.env ?? {}),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLifecycle = createManagedProcessClose(child);

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let addressInUse = false;
      const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
      const collect = (tail: string, text: string) => {
        addressInUse ||= /\bEADDRINUSE\b[\s\S]/.test((tail.length > 16 ? "_" : "") + tail.slice(-16) + text);
        return appendEngineOutputTail(tail, text);
      };
      const finish = () => {
        settled = true;
        clearTimeout(timeout);
        lines.stop();
        stdout = "";
        stderr = "";
        child.removeListener("close", onClose);
      };
      const done = (value: string) => {
        if (settled) return;
        finish();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        finish();
        reject(error);
      };
      const lines = createEngineStartupLineReader((line) => {
        if (!line.startsWith("opencode server listening")) return;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}\n${output()}`));
        done(match[1]);
      });
      const timeoutMs = options.timeoutMs ?? engineSpawnTimeoutMs(15_000);
      const timeout = setTimeout(() => fail(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms\n${output()}`)), timeoutMs);
      const onClose = (code: number | null) => {
        if (!settled) fail(new ManagedOpencodeExitError(code, output(),
          addressInUse || /\bEADDRINUSE$/.test(stdout) || /\bEADDRINUSE$/.test(stderr)));
      };
      child.stdout?.on("data", (chunk) => {
        if (settled) return;
        const text = chunk.toString();
        stdout = collect(stdout, text);
        lines.write(text);
      });
      child.stderr?.on("data", (chunk) => {
        if (settled) return;
        stderr = collect(stderr, chunk.toString());
      });
      child.on("error", fail);
      child.once("close", onClose);
    });
  } catch (error) {
    await processLifecycle.close();
    throw error;
  }

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    execution: {
      command,
      args,
      cwd: options.cwd,
      env: injectedEnv,
    },
    isAlive: processLifecycle.isAlive,
    close: processLifecycle.close,
  };
}

export async function createManagedOpencodeServer(options: ManagedOpencodeServerOptions): Promise<ManagedOpencodeServer> {
  return startupPhase("engine.v1.serve", () => createManagedOpencodeServerInner(options));
}

async function createManagedOpencodeServerInner(options: ManagedOpencodeServerOptions): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  let port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  let env = options.env;
  const retried = new Set<"port" | ForeignStorage>();
  for (;;) {
    try {
      return await startManagedOpencodeServer({ ...options, env }, hostname, port);
    } catch (error) {
      if (options.port === undefined && !retried.has("port") && isRetryableAddressInUseExit(error)) {
        retried.add("port");
        port = await findFreePort(hostname, [...(options.excludedPorts ?? []), port]);
        continue;
      }
      const storage = options.stateDir ? foreignStorageExit(error, mergeEnv([process.env, env])) : null;
      if (options.stateDir && storage && !retried.has(storage)) {
        retried.add(storage);
        env = { ...env, ...(await isolatedEngineStorageEnv(options.stateDir, storage)) };
        continue;
      }
      throw error;
    }
  }
}
