import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
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
   * OpenWork-owned directory the engine may keep private state under. Supplied
   * only so a startup failure caused by another opencode install's storage can
   * be recovered from; omit it to keep the retry disabled.
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
 * Startup failures that mean the storage engine v1 defaulted to belongs to a
 * newer opencode. A v2 database carries `session_v2` and no `session`, which
 * engine v1's bootstrap refuses; a v2 global config carries a `permissions`
 * array that engine v1 rejects outright. Both surface as a code-1 exit with a
 * stable message, so recognising them lets one retry hand the engine a private
 * store instead of leaving the user with an app that cannot start at all.
 *
 * Matching on the engine's own output keeps this honest: a store that already
 * works is never moved, so the shared-history behaviour is unchanged for the
 * users it is correct for.
 */
const FOREIGN_STORAGE_EXIT_PATTERNS = [
  /Database is not empty and has no session table/,
  /V2 permissions are not supported by OpenCode V1/,
];

function isForeignStorageExit(error: unknown): boolean {
  return error instanceof ManagedOpencodeExitError &&
    error.exitCode === 1 &&
    FOREIGN_STORAGE_EXIT_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * A store that a standalone opencode install cannot collide with.
 *
 * `OPENCODE_DB` and `OPENCODE_CONFIG_DIR` mirror what engine v2 already pins
 * (see managed-opencode-v2.ts). `XDG_CONFIG_HOME` is the part engine v1 needs
 * and v2 does not: v1 always loads its global config from
 * `$XDG_CONFIG_HOME/opencode`, and `OPENCODE_CONFIG_DIR` only merges an extra
 * layer on top of that rather than replacing it. Scoping the redirect to the
 * spawned engine leaves OpenWork's own config, runtime database and Electron
 * userData on their existing paths.
 */
async function isolatedEngineStorageEnv(stateDir: string): Promise<Record<string, string>> {
  const root = join(stateDir, "foreign-storage");
  const configDir = join(root, "config");
  // The engine creates the database file but not the directory holding it.
  await mkdir(join(root, "xdg-config", "opencode"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return {
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_CONFIG_DIR: configDir,
  };
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...engineEnvDefaults,
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  // The managed engine needs its own provider environment, but never the key
  // that decrypts OpenWork-owned OAuth credentials.
  delete env.OPENWORK_ENCRYPTION_KEY;
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
  const hostname = options.hostname ?? "127.0.0.1";
  let port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  let env = options.env;
  // At most one recovery attempt, and only for a failure the retry can fix.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await startManagedOpencodeServer({ ...options, env }, hostname, port);
    } catch (error) {
      if (attempt > 0) throw error;
      // The automatic free-port probe is necessarily racy. Retry exactly once
      // on the one startup failure a new port can safely fix; explicit ports
      // and all other code-1 exits remain actionable.
      if (options.port === undefined && isRetryableAddressInUseExit(error)) {
        port = await findFreePort(hostname, [...(options.excludedPorts ?? []), port]);
        continue;
      }
      // A newer standalone opencode owns the storage engine v1 defaults to.
      // Private storage is safe to retry on: it is an unused store, so the
      // retry reuses nothing the failed attempt wrote.
      if (options.stateDir && isForeignStorageExit(error)) {
        env = { ...(options.env ?? {}), ...(await isolatedEngineStorageEnv(options.stateDir)) };
        continue;
      }
      throw error;
    }
  }
}
