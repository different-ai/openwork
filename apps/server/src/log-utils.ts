/**
 * Lightweight log-output utilities shared between server.ts and its tests.
 * This module has no heavy local imports so it can be tested in isolation.
 */

// Maximum byte length for a single log line written to stdout / the file sink.
// Node's internal Buffer pool cannot allocate strings larger than ~2 GB and
// throws a RangeError before the write reaches the OS.  We cap well below that
// so the write always succeeds and the log channel stays open.
const MAX_LOG_LINE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Truncates a log line to MAX_LOG_LINE_BYTES if it would exceed that budget,
 * appending a visible marker so consumers know the record was cut.
 */
export function truncateLogLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_LOG_LINE_BYTES) return line;
  return line.slice(0, MAX_LOG_LINE_BYTES) + " [LOG TRUNCATED]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns true for errors that mean the log output channel is unavailable or
 * that a single record was too large for the runtime's buffer pool.
 * In either case logging must be silenced rather than propagating the error.
 *
 * Logging must not turn an otherwise successful request into a server crash.
 */
export function isUnavailableLogOutputError(error: unknown): boolean {
  // A RangeError from Buffer/process.stdout.write means the individual record
  // was too large for the runtime's buffer pool.  The truncateLogLine guard
  // normally prevents this, but treat it as suppressible here for safety.
  if (error instanceof RangeError) return true;
  if (!isRecord(error)) return false;
  // Redirected stdout can run out of space just like the optional file sink.
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED"
    || error.code === "ENOSPC" || error.code === "EDQUOT" || error.code === "EIO";
}
