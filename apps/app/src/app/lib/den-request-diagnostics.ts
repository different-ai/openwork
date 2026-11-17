import { connectionDiagnosticHistory } from "./connection-diagnostic-history";
import { classifyStartupError } from "./den-transport-errors";
import { emitClientFailure, type DenFailureTarget } from "./client-failure-events";

export async function observeDenRequest<T extends { ok: boolean; status: number }>(
  request: (onTimeout: () => void) => Promise<T>,
  target?: DenFailureTarget,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = Date.now();
  let timedOut = false;
  try {
    const result = await request(() => { timedOut = true; });
    if (!result.ok) {
      connectionDiagnosticHistory.record("den_request_http_failure", "failure", {
        httpStatus: result.status,
        durationMs: Date.now() - startedAt,
      });
    }
    if (target && result.ok) emitClientFailure(null, target);
    if (target && result.status >= 500) emitClientFailure({ component: "den_transport", phase: "request", reason: "server_error", httpStatus: result.status }, target);
    return result;
  } catch (error) {
    const reason = timedOut ? "timeout" : classifyStartupError(error);
    const timeout = timedOut || (typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError");
    if (target && (!signal?.aborted || timeout)) emitClientFailure({ component: "den_transport", phase: "request", reason: reason === "certificate" || reason === "dns" || reason === "offline" || reason === "timeout" || reason === "connection_refused" ? reason : "unknown" }, target);
    connectionDiagnosticHistory.record(timedOut ? "den_request_timeout" : "den_request_transport_failure", "failure", {
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
