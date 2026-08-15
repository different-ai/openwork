import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_THRESHOLD_BYTES = 16 * 1024;

export type ServiceLogWriter = {
  write: (chunk: string) => void;
  flush: () => void;
  close: () => void;
};

/**
 * Bounded, best-effort file sink for service logs. Buffers writes and flushes
 * them to disk on a timer so hot request logs never block the server. Rotates
 * the file to `<path>.1` once it exceeds `maxBytes`, keeping at most two files.
 *
 * Logging must never throw or crash the server: every failure is swallowed.
 */
export function createServiceLogWriter(filePath: string, maxBytes = DEFAULT_MAX_BYTES): ServiceLogWriter {
  let buffer = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  const flushSync = (): void => {
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (existsSync(filePath) && statSync(filePath).size + chunk.length > maxBytes) {
        renameSync(filePath, `${filePath}.1`);
      }
      writeFileSync(filePath, chunk, { flag: "a" });
    } catch {
      // Logging is best-effort; never propagate write failures.
    }
  };

  const write = (chunk: string): void => {
    buffer += chunk;
    if (timer === null) {
      timer = setInterval(flushSync, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
    if (buffer.length >= FLUSH_THRESHOLD_BYTES) {
      flushSync();
    }
  };

  const close = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    flushSync();
  };

  return { write, flush: flushSync, close };
}
