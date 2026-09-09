/** Recover only explicitly rejected, optional title-generation parameters.
 * The private correlation header is removed before every provider request.
 * No prompts, response bodies, URLs, or credentials enter diagnostics.
 */
const HEADER = "x-openwork-title-attempt";
const DEADLINE_MS = 60_000;
const MAX_ERROR_BYTES = 16_384;

type Diagnostic = {
  sessionID: string;
  providerID: string;
  modelID: string;
  outcome: string;
  recoveryAttempt: number;
  status?: number;
  parameter?: string;
};
type Attempt = {
  diagnostic: Diagnostic;
  report: (diagnostic: Diagnostic) => void;
  timer: ReturnType<typeof setTimeout>;
  retried: boolean;
};
const attempts = new Map<string, Attempt>();
let installed = false;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function report(attempt: Attempt, outcome: string, status?: number, parameter?: string) {
  attempt.diagnostic = {
    ...attempt.diagnostic, outcome, recoveryAttempt: attempt.retried ? 2 : 1,
    ...(status === undefined ? {} : { status }),
    ...(parameter === undefined ? {} : { parameter }),
  };
  attempt.report(attempt.diagnostic);
}

function finish(id: string) {
  const attempt = attempts.get(id);
  if (attempt) clearTimeout(attempt.timer);
  attempts.delete(id);
}

async function errorBody(response: Response): Promise<unknown> {
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ERROR_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  } finally {
    // A clone's tee can wait for the original consumer when cancelled.
    void reader.cancel().catch(() => undefined);
  }
}

function correction(body: string, value: unknown): { body: string; parameter: string } | null {
  if (!record(value) || !record(value.error)) return null;
  const error = value.error;
  if (error.code !== "unsupported_value" && error.code !== "unsupported_parameter") return null;
  const parameter = error.param;
  // Never change identity, content, tools, token limits, or required parameters.
  if (parameter !== "reasoning.effort" && parameter !== "reasoning_effort"
    && parameter !== "temperature" && parameter !== "top_p") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!record(parsed)) return null;
  const target = parameter === "reasoning.effort" ? parsed.reasoning : parsed;
  const key = parameter === "reasoning.effort" ? "effort" : parameter;
  if (!record(target) || !Object.hasOwn(target, key)) return null;

  // Provider text is used only to recognize a fixed vocabulary of effort values.
  // If it supplies no recognizable list, let the same model use its default.
  const message = typeof error.message === "string" ? error.message : "";
  const supported = /Supported values are:\s*([^\n]+)/i.exec(message)?.[1] ?? "";
  const efforts = new Set([...supported.matchAll(/['"](none|minimal|low|medium|high|xhigh|max)['"]/g)]
    .map((match) => match[1]));
  const effort = ["low", "minimal", "medium", "high", "xhigh", "max", "none"]
    .find((candidate) => efforts.has(candidate) && candidate !== target[key]);
  if ((parameter === "reasoning.effort" || parameter === "reasoning_effort") && effort) target[key] = effort;
  else delete target[key];
  return { body: JSON.stringify(parsed), parameter };
}

function failure(status: number): string {
  if (status === 401 || status === 403) return "access_rejected";
  if (status === 404) return "model_or_endpoint_missing";
  if (status === 429) return "rate_or_quota_limited";
  if (status === 400 || status === 422) return "request_rejected";
  return "provider_error";
}

function install() {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const id = headers.get(HEADER);
    if (!id) return base(input, init);
    headers.delete(HEADER);
    const externalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    const options = { ...init, headers, signal: externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline };
    const attempt = attempts.get(id);
    // Unknown/expired markers must still never reach a provider.
    if (!attempt) return base(input, options);
    try {
      const response = await base(input, options);
      if (!response.ok) {
        report(attempt, failure(response.status), response.status);
        if (!attempt.retried && response.status === 400 && typeof init?.body === "string") {
          const recovered = correction(init.body, await errorBody(response));
          if (recovered && attempts.get(id) === attempt && !options.signal.aborted) {
            attempt.retried = true;
            report(attempt, "retrying_parameter", response.status, recovered.parameter);
            void response.body?.cancel().catch(() => undefined);
            const retryHeaders = new Headers(headers);
            retryHeaders.delete("content-length");
            const retry = await base(input, { ...options, headers: retryHeaders, body: recovered.body });
            report(attempt, retry.ok ? "accepted_after_recovery" : failure(retry.status), retry.status);
            return retry;
          }
        }
      } else report(attempt, "accepted", response.status);
      return response;
    } catch (error) {
      report(attempt, externalSignal?.aborted ? "cancelled" : deadline.aborted ? "timed_out" : "transport_failed");
      throw error;
    }
  };
  globalThis.fetch = Object.assign(patched, base);
}

// Only export the factory: the engine treats every export as a plugin.
export const OpenWorkTitleRecovery = async (input: {
  client: { app: { log: (input: { body: {
    service: string; level: "info" | "warn"; message: string; extra: Diagnostic;
  } }) => Promise<unknown> } };
}) => {
  install();
  const owned = new Set<string>();
  const emit = (diagnostic: Diagnostic) => {
    const level = ["started", "accepted", "accepted_after_recovery", "title_available"].includes(diagnostic.outcome)
      ? "info" : "warn";
    void input.client.app.log({ body: {
      service: "openwork.title", level, message: "Automatic title generation", extra: diagnostic,
    } }).catch(() => undefined);
  };
  return {
    "chat.headers": async (request: {
      sessionID: string; agent: string; model: { id: string; providerID: string };
    }, output: { headers: Record<string, string> }) => {
      if (request.agent !== "title") return;
      const id = crypto.randomUUID();
      const diagnostic = {
        sessionID: request.sessionID, providerID: request.model.providerID,
        modelID: request.model.id, outcome: "started", recoveryAttempt: 1,
      };
      if (attempts.size >= 512) {
        emit({ ...diagnostic, outcome: "tracking_capacity_reached" });
        return;
      }
      const timer = setTimeout(() => {
        const attempt = attempts.get(id);
        if (attempt && ["started", "accepted", "accepted_after_recovery"].includes(attempt.diagnostic.outcome)) {
          report(attempt, "title_unconfirmed");
        }
        finish(id);
        owned.delete(id);
      }, DEADLINE_MS);
      timer.unref?.();
      attempts.set(id, { diagnostic, report: emit, timer, retried: false });
      owned.add(id);
      output.headers[HEADER] = id;
      emit(diagnostic);
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.updated" || !record(event.properties) || !record(event.properties.info)) return;
      const info = event.properties.info;
      if (typeof info.title !== "string" || !info.title.trim() || info.title.startsWith("New session - ")) return;
      for (const id of owned) {
        const attempt = attempts.get(id);
        if (!attempt || attempt.diagnostic.sessionID !== info.id) continue;
        report(attempt, "title_available");
        finish(id);
        owned.delete(id);
      }
    },
    dispose: async () => {
      for (const id of owned) finish(id);
      owned.clear();
    },
  };
};
