import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Optional append-only file sink for the server logger.
 *
 * The desktop app runs openwork-server in-process, so its stdout is invisible
 * once packaged; without a file sink every engine rollover reason, reload
 * trigger, and MCP re-sync error is emitted and lost. The sink is enabled by
 * OPENWORK_SERVER_LOG_FILE, always receives structured JSON lines regardless
 * of the stdout format, and rotates once so it cannot grow without bound.
 */

export const SERVER_LOG_FILE_ENV = "OPENWORK_SERVER_LOG_FILE";

/** Default rotation threshold. Rollover/reload lines are a few hundred bytes each. */
export const DEFAULT_SERVER_LOG_FILE_MAX_BYTES = 20 * 1024 * 1024;

export type ServerLogFileSink = {
  readonly path: string;
  write: (line: string) => void;
  close: () => void;
};

export type ServerLogFileSinkOptions = {
  path: string;
  maxBytes?: number;
};

const SENSITIVE_ATTRIBUTE_KEY = /(authorization|token|secret|password|api[-_]?key|cookie|credential)/i;

function redactLogText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

function redactLogValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactLogText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, secrets));
  if (typeof value !== "object" || value === null) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_ATTRIBUTE_KEY.test(key) && entry !== null && entry !== undefined
      ? "<redacted>"
      : redactLogValue(entry, secrets);
  }
  return redacted;
}

/**
 * Replace values of credential-looking attribute keys so a persisted log line
 * can never carry a bearer or API key even if a caller passes one by mistake.
 */
export function redactLogAttributes(
  attributes: Record<string, unknown>,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    redacted[key] = SENSITIVE_ATTRIBUTE_KEY.test(key) && value !== null && value !== undefined
      ? "<redacted>"
      : redactLogValue(value, secrets);
  }
  return redacted;
}

export function redactServerLogFileRecord<T extends { body: string; attributes: Record<string, unknown> }>(
  record: T,
  secrets: readonly string[],
): T {
  return {
    ...record,
    body: redactLogText(record.body, secrets),
    attributes: redactLogAttributes(record.attributes, secrets),
  };
}

/**
 * Appends are synchronous on an open descriptor. Server log volume is low and
 * a single append syscall is cheap, while a stream would open its descriptor
 * asynchronously and race the rotation rename.
 */
export function createServerLogFileSink(options: ServerLogFileSinkOptions): ServerLogFileSink {
  const path = options.path;
  const maxBytes = options.maxBytes ?? DEFAULT_SERVER_LOG_FILE_MAX_BYTES;
  let fd: number | null = null;
  let bytes = 0;
  let disabled = false;

  const close = () => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    fd = null;
  };

  const rotate = () => {
    close();
    const previous = `${path}.1`;
    try {
      rmSync(previous, { force: true });
      renameSync(path, previous);
    } catch {
      // A missing or unrenameable file only means we keep appending.
    }
    bytes = 0;
  };

  const open = () => {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "a");
    bytes = fstatSync(fd).size;
    if (bytes >= maxBytes) {
      rotate();
      fd = openSync(path, "a");
      bytes = 0;
    }
  };

  return {
    path,
    write: (line: string) => {
      if (disabled) return;
      try {
        if (fd === null) open();
        if (bytes >= maxBytes) {
          rotate();
          fd = openSync(path, "a");
        }
        const payload = `${line}\n`;
        if (fd !== null) writeSync(fd, payload);
        bytes += Buffer.byteLength(payload, "utf8");
      } catch {
        disabled = true;
        close();
      }
    },
    close,
  };
}

let processSink: ServerLogFileSink | null | undefined;

/** The process-wide sink selected by OPENWORK_SERVER_LOG_FILE, or null when unset. */
export function resolveServerLogFileSink(env: NodeJS.ProcessEnv = process.env): ServerLogFileSink | null {
  if (processSink !== undefined) return processSink;
  const configured = env[SERVER_LOG_FILE_ENV]?.trim();
  processSink = configured ? createServerLogFileSink({ path: configured }) : null;
  return processSink;
}

/** Test seam: forget the memoized process sink. */
export function resetServerLogFileSinkForTests() {
  processSink?.close();
  processSink = undefined;
}
