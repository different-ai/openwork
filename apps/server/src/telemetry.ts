export type ServerTelemetryContext = {
  method?: string;
  route?: string;
  surface?: string;
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

export function captureServerException(error: unknown, context: ServerTelemetryContext = {}): boolean {
  const { requestSignal, ...telemetryContext } = context;
  if (isExpectedRequestCancellation(error, requestSignal)) return false;
  return globalThis.__openworkDesktopTelemetry?.captureException(error, {
    surface: "server",
    ...telemetryContext,
  }) ?? false;
}
