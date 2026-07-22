export const AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES = 1024 * 1024;
export const AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 30_000;

export class AgentContextDiagnosticsFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentContextDiagnosticsFetchError";
    this.code = code;
  }
}

function timeoutError() {
  return new AgentContextDiagnosticsFetchError(
    "agent_context_diagnostics_request_timed_out",
    "Agent context diagnostics request timed out.",
  );
}

function responseTooLargeError() {
  return new AgentContextDiagnosticsFetchError(
    "agent_context_diagnostics_response_too_large",
    "Agent context diagnostics response exceeded the 1 MiB limit.",
  );
}

function cancelUnlockedBody(response) {
  if (!response.body || response.body.locked) return;
  void response.body.cancel().catch(() => undefined);
}

async function readBoundedResponseText(response, signal) {
  const declaredLength = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes > AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES
    ) {
      cancelUnlockedBody(response);
      throw responseTooLargeError();
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw timeoutError();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw responseTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (signal.aborted) throw timeoutError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function boundedDeadlineAt(requestedDeadlineAtMs) {
  const now = Date.now();
  const latestAllowedDeadline = now + AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS;
  const requested = Number(requestedDeadlineAtMs);
  if (!Number.isFinite(requested)) return now;
  return Math.min(requested, latestAllowedDeadline);
}

/**
 * Electron's IPC fetch must consume the body in the main process. Keep that
 * buffering under the renderer's absolute diagnostics deadline and fixed cap.
 */
export async function fetchAgentContextDiagnosticsResponse(
  fetchImpl,
  url,
  init,
  requestedDeadlineAtMs,
) {
  const deadlineAtMs = boundedDeadlineAt(requestedDeadlineAtMs);
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  const controller = new AbortController();
  let timeoutId = null;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, remainingMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, redirect: "error", signal: controller.signal }),
      deadline,
    ]);
    const body = await Promise.race([
      readBoundedResponseText(response, controller.signal),
      deadline,
    ]);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers.entries()),
      body,
    };
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
