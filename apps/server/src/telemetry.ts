import { isDiskFullError, watchedDiskFreeMegabytes } from "./disk-space.js";

export type ServerTelemetryContext = {
  method?: string;
  route?: string;
  surface?: string;
  /** Groups reports into one issue wherever the error was thrown. */
  fingerprint?: string[];
  level?: "warning";
  tags?: Record<string, string>;
  /** Internal-only context; never forwarded to the desktop telemetry host. */
  requestSignal?: AbortSignal;
};

export type OpenworkDesktopTelemetry = {
  captureException: (error: unknown, context?: ServerTelemetryContext) => boolean;
};

declare global {
  // Provided by the Electron host when the embedded server runs in desktop mode.
  // The standalone openwork-server package leaves this unset.
  var __openworkDesktopTelemetry: OpenworkDesktopTelemetry | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isExpectedRequestCancellation(error: unknown, requestSignal: AbortSignal | undefined): boolean {
  if (!requestSignal?.aborted) return false;
  // Abort reasons may legally be null (including a canceled empty HEAD body).
  if (error === requestSignal.reason) return true;
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (current === requestSignal.reason) return true;
    if (!isRecord(current) || visited.has(current)) return false;
    visited.add(current);
    if (current.name === "AbortError") return true;
    if (
      current.code === "ABORT_ERR" ||
      current.code === "ECONNRESET" ||
      current.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      current.code === "UND_ERR_SOCKET"
    ) return true;
    const message = current.message;
    if (typeof message === "string" && /^(?:The operation was )?aborted\.?$|^terminated$/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

const DISK_FULL_REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastDiskFullReportAt: number | null = null;

/**
 * A full disk is the state of someone's computer, not a defect, and every
 * write fails while it lasts. Report it as one grouped warning per interval,
 * with the space that was left. Null means this one is not reported.
 */
function diskFullReport(): Pick<ServerTelemetryContext, "fingerprint" | "level" | "tags"> | null {
  const now = Date.now();
  if (lastDiskFullReportAt !== null && now - lastDiskFullReportAt < DISK_FULL_REPORT_INTERVAL_MS) return null;
  lastDiskFullReportAt = now;
  const freeMegabytes = watchedDiskFreeMegabytes();
  return {
    fingerprint: ["disk-full"],
    level: "warning",
    tags: { "disk.free_mb": freeMegabytes === null ? "unknown" : String(freeMegabytes) },
  };
}

export function resetDiskFullReportsForTests(): void {
  lastDiskFullReportAt = null;
}

export function captureServerException(error: unknown, context: ServerTelemetryContext = {}): boolean {
  const { requestSignal, ...telemetryContext } = context;
  if (isExpectedRequestCancellation(error, requestSignal)) return false;
  const diskFull = isDiskFullError(error) ? diskFullReport() : undefined;
  if (diskFull === null) return false;
  return globalThis.__openworkDesktopTelemetry?.captureException(error, {
    surface: "server",
    ...telemetryContext,
    ...diskFull,
  }) ?? false;
}
