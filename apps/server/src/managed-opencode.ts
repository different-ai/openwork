import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { deleteEnv, mergeEnv } from "@openwork/paths";
import { startupPhase } from "./startup-phase.js";
import { randomUUID } from "node:crypto";
import { appendEngineOutputTail, createEngineStartupLineReader } from "./engine-output.js";

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
        // Re-check through the exit event before escalating.
      }
      if (await waitForExit(options.termTimeoutMs ?? 1_000)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Re-check below; kill can race a natural exit.
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
  /**
   * OpenWork-owned directory engine v1 may move its database or global config
   * into when a standalone OpenCode v2 install owns the shared ones. Omit it to
   * keep that recovery disabled.
   */
  stateDir?: string;
};

class ManagedOpencodeExitError extends Error {
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

/**
 * Engine v1 and a standalone OpenCode v2 share the same default database and
 * global config paths. A v2 database has `session_v2` and no `session`, and a
 * v2 global config may use the `permissions` array; v1 exits 1 on either, and
 * the whole app then fails to start.
 *
 * Each collision moves only the part that collided, and only after v1 refused
 * it. A shared database that v1 can open is never moved, so existing v1 history
 * (the source of the v1 to v2 history migration) stays where it was.
 */
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

/** Which shared store, if any, made engine v1 exit. Project config errors are not ours to move. */
function foreignStorageExit(error: unknown, env: NodeJS.ProcessEnv): ForeignStorage | null {
  if (!(error instanceof ManagedOpencodeExitError) || error.exitCode !== 1) return null;
  if (!env.OPENCODE_DB?.trim() && FOREIGN_DATABASE_EXIT.test(error.message)) return "database";
  const config = error.message.match(FOREIGN_CONFIG_EXIT)?.[1]?.trim();
  if (config && isInside(globalOpencodeConfigDir(env), config)) return "config";
  return null;
}

let isolatedDatabase: string | undefined;

/**
 * The private database engine v1 was moved to in this process, if any. Its
 * chats live there rather than in the shared path, so the v1 to v2 history
 * migration must read them from here.
 */
export function isolatedOpencodeV1Database(): string | undefined {
  return isolatedDatabase;
}

/**
 * Private storage for the part that collided. `XDG_CONFIG_HOME` is the only way
 * to move v1's global config: `OPENCODE_CONFIG_DIR` only adds a layer on top.
 * It is set on the engine process alone, so OpenWork's own paths do not move.
 */
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
  // The engine's in-process npm installs use Arborist, which audits by default.
  // That audit POST depends on npm's advisories endpoint, which has been observed
  // to hang for the full five-minute registry timeout, so first-run must not wait.
  // @npmcli/config reads npm_config_* settings from the environment.
  const engineEnvDefaults = { npm_config_audit: "false" };
  const env: NodeJS.ProcessEnv = mergeEnv([
    process.env,
    engineEnvDefaults,
    options.env,
    { OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
  ]);
  // The managed engine needs its own provider environment, but never the key
  // that decrypts OpenWork-owned OAuth credentials, under any Windows spelling.
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
        // Remember the retry signal even if later diagnostics evict it. Keep
        // stream boundaries separate, including a token split across chunks.
        // Do not invent a word boundary where the overlap was cut.
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
      const timeout = setTimeout(() => fail(new Error(`Timeout waiting for OpenCode server after ${options.timeoutMs ?? 15000}ms\n${output()}`)), options.timeoutMs ?? 15000);
      const onClose = (code: number | null) => {
        if (!settled) fail(new ManagedOpencodeExitError(code, output(),
          addressInUse || /\bEADDRINUSE$/.test(stdout) || /\bEADDRINUSE$/.test(stderr)));
      };
      child.stdout?.on("data", (chunk) => {
        // Keep draining both pipes after startup, without decoding or parsing.
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
      // ChildProcess can emit "exit" before its stdio pipes have drained. Wait
      // for "close" so retry classification includes every diagnostic line.
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
  // Each recovery is taken at most once, independently: a machine whose v2
  // install owns both the database and the global config needs both moved, and
  // a moved engine can still lose the free-port race.
  const retried = new Set<"port" | ForeignStorage>();
  for (;;) {
    try {
      return await startManagedOpencodeServer({ ...options, env }, hostname, port);
    } catch (error) {
      // The automatic free-port probe is necessarily racy. Retry exactly once on
      // the one startup failure that a new port can safely fix; explicit ports
      // and all other code-1 exits remain actionable.
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
