import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  redactObservabilityValue,
  type ObservabilityEventInput,
  type ObservabilityLevel,
} from "@openwork/observability";

export type ManagedOpencodeObserver = (event: ObservabilityEventInput) => void | Promise<void>;

export type ManagedOpencodeServer = {
  instanceId: string;
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
const MAX_PENDING_LINE_CHARS = 64 * 1024;
const MAX_STARTUP_OUTPUT_CHARS = 32 * 1024;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type StructuredOpencodeLog = Record<string, string>;

type ManagedProcessTermination = {
  code: number | null;
  signal: NodeJS.Signals | null;
  observedAt: string;
  expected: boolean;
};

export function parseStructuredOpencodeLog(line: string): StructuredOpencodeLog | null {
  const fields: StructuredOpencodeLog = {};
  const pattern = /(?:^|\s)([A-Za-z0-9_.-]+)=("(?:\\.|[^"])*"|[^\s]+)/g;
  for (const match of line.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2];
    if (!key || raw === undefined) continue;
    if (raw.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        fields[key] = typeof parsed === "string" ? parsed : String(parsed);
        continue;
      } catch {
        // Keep the original bounded line token when quoted parsing fails.
      }
    }
    fields[key] = raw;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function structuredLogLevel(fields: StructuredOpencodeLog | null, stream: "stdout" | "stderr"): ObservabilityLevel {
  const level = fields?.level?.toUpperCase();
  if (level === "DEBUG") return "debug";
  if (level === "INFO") return "info";
  if (level === "WARN" || level === "WARNING") return "warn";
  if (level === "ERROR" || level === "FATAL") return "error";
  return stream === "stderr" ? "warn" : "debug";
}

function mcpLogMetadata(fields: StructuredOpencodeLog | null): {
  action: string;
  level: ObservabilityLevel;
  data: Record<string, unknown>;
} | null {
  if (!fields) return null;
  const message = fields.message ?? "";
  const server = fields.key ?? fields.server;
  const status = fields.status;
  const unavailable = message.toLowerCase() === "server unavailable";
  const closed = message.toLowerCase().includes("mcp connection closed");
  if (!server || (!unavailable && !closed && status !== "failed" && !status?.startsWith("needs_"))) {
    return null;
  }
  const action = closed
    ? "mcp.connection.closed"
    : status === "needs_auth" || status === "needs_client_registration"
      ? "mcp.connection.needs-auth"
      : "mcp.connection.failed";
  return {
    action,
    level: action === "mcp.connection.failed" || action === "mcp.connection.closed" ? "error" : "warn",
    data: {
      server,
      ...(fields.type ? { transportType: fields.type } : {}),
      ...(status ? { status } : {}),
      ...(message ? { message } : {}),
    },
  };
}

function safeObserve(observer: ManagedOpencodeObserver | undefined, event: ObservabilityEventInput): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(event)).catch(() => undefined);
  } catch {
    // Observability must never alter managed process behavior.
  }
}

function createLineBuffer(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
        newline = pending.indexOf("\n");
      }
      // A child can emit an arbitrarily long unterminated line. Forward a
      // bounded chunk and retain only the tail needed for subsequent parsing.
      while (pending.length > MAX_PENDING_LINE_CHARS) {
        onLine(`${pending.slice(0, MAX_PENDING_LINE_CHARS)}…[continued]`);
        pending = pending.slice(MAX_PENDING_LINE_CHARS);
      }
    },
    flush() {
      if (pending.length > 0) onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
      pending = "";
    },
  };
}

function createStreamingSecretRedactor(
  values: string[],
  onChunk: (chunk: string) => void,
): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  const secrets = [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const candidatesByFirstCharacter = new Map<string, string[]>();
  for (const secret of secrets) {
    const firstCharacter = secret[0];
    if (!firstCharacter) continue;
    const candidates = candidatesByFirstCharacter.get(firstCharacter) ?? [];
    candidates.push(secret);
    candidatesByFirstCharacter.set(firstCharacter, candidates);
  }

  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emitAvailable = (final: boolean) => {
    let index = 0;
    let literalStart = 0;
    const output: string[] = [];

    while (index < pending.length) {
      const current = pending[index];
      const candidates = current ? candidatesByFirstCharacter.get(current) : undefined;
      if (!candidates) {
        index += 1;
        continue;
      }

      const match = candidates.find((secret) => pending.startsWith(secret, index));
      if (match) {
        if (literalStart < index) output.push(pending.slice(literalStart, index));
        output.push("[REDACTED]");
        index += match.length;
        literalStart = index;
        continue;
      }

      const remaining = pending.slice(index);
      if (!final && candidates.some((secret) => secret.startsWith(remaining))) break;
      index += 1;
    }

    if (literalStart < index) output.push(pending.slice(literalStart, index));
    pending = pending.slice(index);
    if (output.length > 0) onChunk(output.join(""));
  };

  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      emitAvailable(false);
    },
    flush() {
      pending += decoder.end();
      emitAvailable(true);
      pending = "";
    },
  };
}

function consumeChildOutput(
  stream: Readable | null,
  onData: (chunk: Buffer | string) => void,
  finalize: () => void,
): Promise<void> {
  if (!stream) {
    try {
      finalize();
    } catch {
      // Observability must never alter managed process behavior.
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let drained = false;
    const finish = () => {
      if (drained) return;
      drained = true;
      stream.off("data", onData);
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", finish);
      try {
        finalize();
      } catch {
        // Observability must never alter managed process behavior.
      }
      resolve();
    };
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
    if (stream.readableEnded || stream.destroyed) queueMicrotask(finish);
  });
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
  observe?: ManagedOpencodeObserver;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  const username = randomSecret();
  const password = randomSecret();
  // --print-logs is a pinned OpenCode global flag. Output remains ephemeral
  // unless the server journal is enabled, and text is always policy-controlled
  // content rather than metadata.
  const args = ["serve", "--print-logs", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  const instanceId = randomUUID();
  const spawnedAt = new Date().toISOString();
  const env = {
    ...process.env,
    ...options.env,
    OPENWORK_OPENCODE_INSTANCE_ID: instanceId,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const injectedEnv = Object.entries({
    ...(options.env ?? {}),
    OPENWORK_OPENCODE_INSTANCE_ID: instanceId,
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
  const secretValues = [...new Set([
    username,
    password,
    ...Object.entries(env)
      .filter((entry): entry is [string, string] => (
        SECRET_ENV_PATTERN.test(entry[0])
        && typeof entry[1] === "string"
        && entry[1].length > 0
      ))
      .map(([, value]) => value),
  ])].sort((left, right) => right.length - left.length);
  const redactProcessLine = (line: string) => String(redactObservabilityValue(secretValues.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
    line,
  )));
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const source = { runtime: "openwork-server" as const, component: "managed-opencode", instanceId };
  safeObserve(options.observe, {
    level: "info",
    scope: "process",
    action: "opencode.process.spawned",
    source,
    observedAt: spawnedAt,
    data: {
      pid: child.pid ?? null,
      command,
      args,
      cwd: options.cwd,
      injectedEnvNames: injectedEnv.map((entry) => entry.name),
    },
  });

  let closePromise: Promise<void> | null = null;
  let closeRequested = false;
  let startupOutput = "";
  let listeningUrl: string | null = null;
  let terminationInfo: ManagedProcessTermination | null = null;

  const appendStartupOutput = (stream: "stdout" | "stderr", line: string) => {
    startupOutput += `${stream}: ${line}\n`;
    if (startupOutput.length > MAX_STARTUP_OUTPUT_CHARS) {
      startupOutput = startupOutput.slice(-MAX_STARTUP_OUTPUT_CHARS);
    }
  };
  const observeLine = (stream: "stdout" | "stderr", line: string) => {
    const redactedLine = redactProcessLine(line);
    const fields = parseStructuredOpencodeLog(redactedLine);
    const level = structuredLogLevel(fields, stream);
    const observedAt = fields?.timestamp && Number.isFinite(Date.parse(fields.timestamp))
      ? new Date(fields.timestamp).toISOString()
      : new Date().toISOString();
    appendStartupOutput(stream, redactedLine);
    safeObserve(options.observe, {
      level,
      scope: "process",
      action: `opencode.process.${stream}`,
      source,
      observedAt,
      data: {
        pid: child.pid ?? null,
        stream,
        ...(fields?.level ? { logLevel: fields.level } : {}),
      },
      content: {
        kind: "text",
        hash: sha256(redactedLine),
        length: redactedLine.length,
        value: redactedLine,
      },
    });
    const mcp = mcpLogMetadata(fields);
    if (mcp) {
      safeObserve(options.observe, {
        level: mcp.level,
        scope: "mcp",
        action: mcp.action,
        source: { ...source, operation: "structured-log" },
        observedAt,
        data: { pid: child.pid ?? null, ...mcp.data },
        content: {
          kind: "opencode-log-line",
          hash: sha256(redactedLine),
          length: redactedLine.length,
          value: redactedLine,
        },
      });
    }
  };

  let resolveListening: ((url: string) => void) | null = null;
  const detectListening = (line: string) => {
    if (listeningUrl || !line.startsWith("opencode server listening")) return;
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    if (!match?.[1]) return;
    listeningUrl = match[1];
    safeObserve(options.observe, {
      level: "info",
      scope: "process",
      action: "opencode.process.listening",
      source,
      observedAt: new Date().toISOString(),
      data: { pid: child.pid ?? null, url: listeningUrl },
    });
    if (!terminationInfo) resolveListening?.(listeningUrl);
  };
  const stdoutLines = createLineBuffer((line) => observeLine("stdout", line));
  const stderrLines = createLineBuffer((line) => observeLine("stderr", line));
  const stdoutReadinessLines = createLineBuffer(detectListening);
  const stdoutRedactor = createStreamingSecretRedactor(secretValues, (chunk) => stdoutLines.push(chunk));
  const stderrRedactor = createStreamingSecretRedactor(secretValues, (chunk) => stderrLines.push(chunk));
  const stdoutDrained = consumeChildOutput(
    child.stdout,
    (chunk) => {
      stdoutReadinessLines.push(chunk);
      stdoutRedactor.push(chunk);
    },
    () => {
      stdoutRedactor.flush();
      stdoutLines.flush();
      stdoutReadinessLines.flush();
    },
  );
  const stderrDrained = consumeChildOutput(
    child.stderr,
    (chunk) => stderrRedactor.push(chunk),
    () => {
      stderrRedactor.flush();
      stderrLines.flush();
    },
  );

  const processTerminated = new Promise<ManagedProcessTermination>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminationInfo) return;
      terminationInfo = {
        code,
        signal,
        observedAt: new Date().toISOString(),
        expected: closeRequested,
      };
      child.off("exit", settle);
      child.off("close", settle);
      resolve(terminationInfo);
    };
    child.once("exit", settle);
    // Spawn failures can close without an exit event. Treat close as the
    // fallback termination signal while still waiting for both output pipes.
    child.once("close", settle);
  });
  const exited = (async () => {
    const info = await processTerminated;
    await Promise.all([stdoutDrained, stderrDrained]);
    safeObserve(options.observe, {
      level: info.expected || info.code === 0 ? "info" : "error",
      scope: "process",
      action: "opencode.process.exited",
      source,
      observedAt: info.observedAt,
      data: {
        pid: child.pid ?? null,
        code: info.code,
        signal: info.signal,
        expected: info.expected,
      },
    });
    return info;
  })();
  child.on("error", (error) => {
    safeObserve(options.observe, {
      level: "error",
      scope: "process",
      action: "opencode.process.error",
      source,
      observedAt: new Date().toISOString(),
      cause: error,
      data: { pid: child.pid ?? null },
    });
  });

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        settleReject(new Error(`Timeout waiting for OpenCode server after ${options.timeoutMs ?? 15000}ms`));
      }, options.timeoutMs ?? 15000);
      const onError = (error: Error) => settleReject(error);
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("error", onError);
        resolveListening = null;
      };
      resolveListening = settleResolve;
      child.once("error", onError);
      void exited.then((info) => settleReject(new Error(
        `OpenCode server exited with code ${info.code}${startupOutput.trim() ? `\n${startupOutput}` : ""}`,
      )));
      if (listeningUrl) settleResolve(listeningUrl);
    });
  } catch (error) {
    safeObserve(options.observe, {
      level: "error",
      scope: "process",
      action: "opencode.process.start.failed",
      source,
      observedAt: new Date().toISOString(),
      cause: error,
      data: { pid: child.pid ?? null },
    });
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
    throw error;
  }

  return {
    instanceId,
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
        closeRequested = true;
        safeObserve(options.observe, {
          level: "info",
          scope: "process",
          action: "opencode.process.close.requested",
          source,
          observedAt: new Date().toISOString(),
          data: { pid: child.pid ?? null },
        });
        if (child.exitCode === null && child.signalCode === null) {
          if (!child.killed) child.kill("SIGTERM");
        }
        let drainTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, 1000);
            }),
          ]);
        } finally {
          if (drainTimer) clearTimeout(drainTimer);
        }
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
          let killTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            await Promise.race([
              exited,
              new Promise<void>((resolve) => {
                killTimer = setTimeout(resolve, 500);
              }),
            ]);
          } finally {
            if (killTimer) clearTimeout(killTimer);
          }
        }
        safeObserve(options.observe, {
          level: "info",
          scope: "process",
          action: "opencode.process.close.completed",
          source,
          observedAt: new Date().toISOString(),
          data: { pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode },
        });
      })();
      return closePromise;
    },
  };
}
