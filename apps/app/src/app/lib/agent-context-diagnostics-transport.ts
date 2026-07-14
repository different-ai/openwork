export const AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES = 1024 * 1024;
export const AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 30_000;

export type AgentContextDiagnosticsTransportErrorCode =
  | "agent_context_diagnostics_request_timed_out"
  | "agent_context_diagnostics_response_too_large";

export class AgentContextDiagnosticsTransportError extends Error {
  readonly code: AgentContextDiagnosticsTransportErrorCode;

  constructor(code: AgentContextDiagnosticsTransportErrorCode, message: string) {
    super(message);
    this.name = "AgentContextDiagnosticsTransportError";
    this.code = code;
  }
}

export type AgentContextDiagnosticsFetch = (
  input: RequestInfo | URL,
  init: RequestInit,
  deadlineAtMs: number,
) => Promise<Response>;

type AgentContextDiagnosticsTransportResult = {
  response: Response;
  payload: unknown;
};

function timeoutError(): AgentContextDiagnosticsTransportError {
  return new AgentContextDiagnosticsTransportError(
    "agent_context_diagnostics_request_timed_out",
    "Agent context diagnostics request timed out.",
  );
}

function responseTooLargeError(): AgentContextDiagnosticsTransportError {
  return new AgentContextDiagnosticsTransportError(
    "agent_context_diagnostics_response_too_large",
    "Agent context diagnostics response exceeded the 1 MiB limit.",
  );
}

function cancelUnlockedBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel().catch(() => undefined);
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
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
  const chunks: Uint8Array[] = [];
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

/**
 * Runs the diagnostics request under one deadline that remains active until
 * the bounded response body has been consumed and parsed.
 */
export async function requestAgentContextDiagnosticsPayload(options: {
  fetchImpl: AgentContextDiagnosticsFetch;
  url: string;
  init: RequestInit;
  timeoutMs?: number;
}): Promise<AgentContextDiagnosticsTransportResult> {
  const timeoutMs = options.timeoutMs ?? AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError("Agent context diagnostics timeout must be between 1 ms and 30 seconds.");
  }

  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      options.fetchImpl(
        options.url,
        { ...options.init, redirect: "error", signal: controller.signal },
        deadlineAtMs,
      ),
      deadline,
    ]);
    const text = await Promise.race([
      readBoundedResponseText(response, controller.signal),
      deadline,
    ]);
    return {
      response,
      payload: text ? JSON.parse(text) : null,
    };
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
