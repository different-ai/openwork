import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { resolvePromptDebugSetting } from "./opencode-plugins/openwork-debug-log.js";

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

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;
const SAFE_PROCESS_ERROR_CODE = /^[A-Z0-9_-]{1,32}$/;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

export function shouldForwardManagedEngineOutput(
  parentEnv: NodeJS.ProcessEnv,
  injectedEnv: Record<string, string | undefined>,
): boolean {
  return resolvePromptDebugSetting({
    ...parentEnv,
    ...injectedEnv,
  }).enabled;
}

export function managedEngineOutputLevel(
  parentEnv: NodeJS.ProcessEnv,
  injectedEnv: Record<string, string | undefined>,
): "off" | "metadata" | "exact" {
  return resolvePromptDebugSetting({ ...parentEnv, ...injectedEnv }).level;
}

export type ManagedEngineOutputForwarder = {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
};

const DEFAULT_MAX_OBSERVABILITY_LINE_CHARS = 2 * 1024 * 1024;
const PROMPT_DUMP_BEGIN = "[openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY";
const PROMPT_DUMP_END = "[openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY";

/**
 * ChildProcess emits `error` outside normal stdout/stderr lifecycle events.
 * Keep a permanent, content-safe listener so an error after readiness cannot
 * become an uncaught EventEmitter exception. Never copy Error.message: it may
 * contain a command, path, or environment-derived detail.
 */
export function attachManagedEngineLifecycleErrorHandler(
  child: ChildProcess,
  write: (value: string) => void = (value) => process.stderr.write(value),
): () => void {
  const onError = (error: unknown) => {
    const rawCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const code = SAFE_PROCESS_ERROR_CODE.test(rawCode) ? rawCode : "unknown";
    write(`[openwork][managed-engine] child process error: code=${code}\n`);
  };
  child.on("error", onError);
  return () => child.off("error", onError);
}

const MAX_STARTUP_OUTPUT_CHARS = 64 * 1024;

function appendBoundedStartupOutput(current: string, chunk: Buffer | string): string {
  const next = current + (typeof chunk === "string" ? chunk : chunk.toString());
  return next.length <= MAX_STARTUP_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_STARTUP_OUTPUT_CHARS);
}

/**
 * Capture only enough child output to discover the startup URL or explain a
 * startup failure. These listeners are detached on every settlement path so
 * later prompt diagnostics are never retained by the startup parser.
 */
export function waitForManagedOpencodeUrl(
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onStdout = (chunk: Buffer | string) => {
      if (settled) return;
      output = appendBoundedStartupOutput(output, chunk);
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) {
          fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
          return;
        }
        done(match[1]);
        return;
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      if (settled) return;
      output = appendBoundedStartupOutput(output, chunk);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null) => fail(
      new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output}` : ""}`),
    );

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    timeout = setTimeout(
      () => fail(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

/**
 * Forward only OpenWork-owned structured observability records. Exact prompt
 * dump payload lines are allowed only between authenticated observer boundary
 * markers; unrelated OpenCode/plugin stdout and stderr are deliberately
 * dropped because they can contain secrets and are not part of this feature's
 * logging contract. Logical lines are bounded so a child that never emits a
 * newline cannot grow the parent process indefinitely.
 */
export function createManagedEngineOutputForwarder(
  stream: "stdout" | "stderr",
  mode: boolean | "off" | "metadata" | "exact",
  write: (value: string) => void = (value) => process.stderr.write(value),
  maxLineChars = DEFAULT_MAX_OBSERVABILITY_LINE_CHARS,
): ManagedEngineOutputForwarder {
  const enabled = mode === true || mode === "metadata" || mode === "exact";
  const exact = mode === true || mode === "exact";
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  let insidePromptDump = false;
  let droppingOversizeLine = false;

  const writeLine = (line: string) => {
    write(`[opencode:${stream}] ${line}\n`);
  };

  const shouldForward = (line: string) =>
    (exact && insidePromptDump) || line.startsWith("[openwork][");

  const emitLine = (line: string) => {
    const normalized = line.replace(/\r$/, "");
    const forward = shouldForward(normalized);
    if (forward) writeLine(normalized);
    if (exact && normalized.startsWith(PROMPT_DUMP_BEGIN)) insidePromptDump = true;
    if (normalized.startsWith(PROMPT_DUMP_END)) insidePromptDump = false;
  };

  const omitOversizeLine = (line: string) => {
    if (!shouldForward(line)) return;
    writeLine(
      `[openwork][managed-engine] observability line omitted: reason=max-line-chars limit=${maxLineChars}`,
    );
  };

  const emitCompleteLines = () => {
    while (true) {
      if (droppingOversizeLine) {
        const newline = remainder.indexOf("\n");
        if (newline < 0) {
          remainder = "";
          return;
        }
        remainder = remainder.slice(newline + 1);
        droppingOversizeLine = false;
        continue;
      }
      const newline = remainder.indexOf("\n");
      if (newline < 0) {
        if (remainder.length <= maxLineChars) return;
        omitOversizeLine(remainder);
        remainder = "";
        droppingOversizeLine = true;
        return;
      }
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      if (line.length > maxLineChars) omitOversizeLine(line);
      else emitLine(line);
    }
  };

  return {
    push(chunk) {
      if (!enabled) return;
      remainder += typeof chunk === "string" ? chunk : decoder.write(chunk);
      emitCompleteLines();
    },
    flush() {
      if (!enabled) return;
      remainder += decoder.end();
      emitCompleteLines();
      if (droppingOversizeLine) {
        remainder = "";
        return;
      }
      if (!remainder) return;
      if (remainder.length > maxLineChars) omitOversizeLine(remainder);
      else emitLine(remainder);
      remainder = "";
    },
  };
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

export async function createManagedOpencodeServer(options: {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  const env = {
    ...process.env,
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const forwardOutput = managedEngineOutputLevel(process.env, options.env ?? {});
  const injectedEnv = Object.entries({
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
  attachManagedEngineLifecycleErrorHandler(child);

  // Forward engine diagnostics only when the assembled child environment opts
  // in. Startup parsing below remains active regardless of this display gate.
  const stdoutForwarder = createManagedEngineOutputForwarder("stdout", forwardOutput);
  const stderrForwarder = createManagedEngineOutputForwarder("stderr", forwardOutput);
  child.stdout?.on("data", stdoutForwarder.push);
  child.stderr?.on("data", stderrForwarder.push);
  child.stdout?.once("end", stdoutForwarder.flush);
  child.stderr?.once("end", stderrForwarder.flush);

  let closePromise: Promise<void> | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const url = await waitForManagedOpencodeUrl(child, options.timeoutMs ?? 15000);

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
    isAlive() {
      return child.exitCode === null && child.signalCode === null && !child.killed;
    },
    close() {
      closePromise ??= (async () => {
        if (child.exitCode !== null) return;
        if (!child.killed) child.kill("SIGTERM");
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 1000);
        });
        await Promise.race([exited, timeout]);
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
          await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => resolve(), 500))]);
        }
      })();
      return closePromise;
    },
  };
}
