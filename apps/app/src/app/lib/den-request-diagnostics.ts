import { connectionDiagnosticHistory } from "./connection-diagnostic-history";

export async function observeDenRequest<T extends { ok: boolean; status: number }>(
  request: (onTimeout: () => void) => Promise<T>,
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
    return result;
  } catch (error) {
    connectionDiagnosticHistory.record(timedOut ? "den_request_timeout" : "den_request_transport_failure", "failure", {
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
