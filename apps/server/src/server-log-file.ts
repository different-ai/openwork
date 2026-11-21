import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const SERVER_LOG_FILE_ENV = "OPENWORK_SERVER_LOG_FILE";

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

export function resolveServerLogFileSink(env: NodeJS.ProcessEnv = process.env): ServerLogFileSink | null {
  if (processSink !== undefined) return processSink;
  const configured = env[SERVER_LOG_FILE_ENV]?.trim();
  processSink = configured ? createServerLogFileSink({ path: configured }) : null;
  return processSink;
}

export function resetServerLogFileSinkForTests() {
  processSink?.close();
  processSink = undefined;
}
