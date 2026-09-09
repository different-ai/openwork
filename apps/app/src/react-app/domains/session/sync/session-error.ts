import type { UIMessage } from "ai";

import { safeStringify } from "../../../../app/utils";
import { normalizeErrorText } from "../../../../lib/error-text";

export type OpencodeSessionErrorKind = "aborted" | "provider-timeout" | "provider-incomplete" | "free-model-limit" | "disk-full" | "database-error" | "gateway-auth-required" | "gateway-selection-required" | "generic";

export type OpencodeSessionErrorPresentation = {
  kind: OpencodeSessionErrorKind;
  title: string;
  description: string | null;
  technicalDetails: string;
  recoveryPrompt: string | null;
  /**
   * `gateway-auth-required` only: the OpenWork Gateway's OAuth start URL for
   * this member (`error.auth_url` in the 401 body). Null when the body omitted
   * it — the renderer then deep-links to Settings > AI providers. Additive.
   */
  connectUrl?: string | null;
};

/** Error code the OpenWork inference gateway returns when the member's own sign-in is missing or revoked. */
export const GATEWAY_AUTH_REQUIRED_ERROR_CODE = "openwork_auth_required";
export const GATEWAY_AUTH_REQUIRED_TITLE = "Sign in to this OpenWork Gateway provider to keep using it";

export const interruptedTaskRecoveryPrompt = [
  "Continue the interrupted task from the current state.",
  "First inspect the conversation and workspace to verify which actions already completed.",
  "Preserve completed work, do not repeat side effects, and finish only what remains.",
].join(" ");

function recordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function firstStringValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstNumberValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function defaultErrorMessage(name: string | null, fallback: string) {
  if (name === "ProviderAuthError") return "Provider authentication failed";
  if (name === "MessageOutputLengthError") return "The model reached its output limit before finishing";
  if (name === "StructuredOutputError") return "The model could not produce valid structured output";
  if (name === "ContextOverflowError") return "The conversation is too large for the model context window";
  if (name === "MessageAbortedError") return "The message was interrupted";
  return fallback;
}

function sessionErrorKind(
  name: string | null,
  message: string | null,
  code: string | null,
  responseBody: string | null,
): OpencodeSessionErrorKind {
  const searchable = [name, message, code, responseBody].filter(Boolean).join(" ");
  if (searchable.includes("gateway_selection_required")) return "gateway-selection-required";
  if (/\b(?:ENOSPC|EDQUOT|SQLITE_FULL)\b|no space left on device|database or disk is full|disk quota exceeded/i.test(searchable)) {
    return "disk-full";
  }
  if (/\bSqlError\b|\bSQLITE_(?:IOERR|CANTOPEN|CORRUPT)\b/i.test(searchable)) {
    return "database-error";
  }
  if (
    name === "MessageAbortedError" ||
    code === "ABORT_ERR" ||
    /\b(?:message\s+)?abort(?:ed)?\b/i.test(searchable)
  ) {
    return "aborted";
  }
  if (
    name === "ProviderHeaderTimeoutError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /(?:response\s+)?headers?.{0,20}(?:timed?\s*out|timeout)/i.test(searchable)
  ) {
    return "provider-timeout";
  }
  if (/upstream_(?:incomplete|interrupted|malformed_stream|malformed_response|timeout)/.test(searchable)) return "provider-incomplete";
  if (responseBody?.includes("FreeUsageLimitError") || message?.includes("FreeUsageLimitError")) {
    return "free-model-limit";
  }
  return "generic";
}

function errorTitle(kind: OpencodeSessionErrorKind, fallback: string) {
  if (kind === "disk-full") return "Storage error reported";
  if (kind === "database-error") return "OpenWork couldn’t access its saved data";
  if (kind === "aborted") return "Task interrupted";
  if (kind === "provider-timeout") return "Provider did not respond in time";
  if (kind === "provider-incomplete") return "The model response was interrupted";
  if (kind === "free-model-limit") return "The free starter model is busy right now";
  if (kind === "gateway-auth-required") return GATEWAY_AUTH_REQUIRED_TITLE;
  if (kind === "gateway-selection-required") return "Choose a Gateway model group and credential set";
  return fallback;
}

function errorDescription(kind: OpencodeSessionErrorKind, gatewayAuth: GatewayAuthRequired | null) {
  if (kind === "gateway-selection-required") return "More than one access rule can apply. Open the model picker and select the model with the group and credential set you want, then retry. No credential is selected automatically.";
  if (kind === "disk-full") {
    return "A storage limit was reported by the task runtime or a connected service. This does not necessarily mean your computer is full. Check the affected service or workspace before freeing local disk space.";
  }
  if (kind === "database-error") {
    return "Try again. If this keeps happening, check the available disk space on the device running this task and restart OpenWork. For a cloud workspace, contact its administrator.";
  }
  if (kind === "aborted") {
    return "OpenCode stopped before the task finished. Output and files already produced are kept.";
  }
  if (kind === "provider-timeout") {
    return "The provider connection timed out before a response began. Output and files already produced are kept.";
  }
  if (kind === "provider-incomplete") return "The response may contain partial text or incomplete tool calls. Review them before continuing.";
  if (kind === "free-model-limit") {
    return "Too many people are using the free model at once. Wait a few minutes and try again, or connect your own model provider in Settings → AI Providers to keep working.";
  }
  if (kind === "gateway-auth-required") {
    return gatewayAuth?.message ?? "Your sign-in for this provider is missing or was revoked. Connect it again, then retry.";
  }
  return null;
}

type GatewayAuthRequired = { connectUrl: string | null; message: string | null };

/**
 * Detects the gateway's in-band `401 { error: { code: "openwork_auth_required",
 * message, auth_url?, provider_id } }`. The body reaches us as a string on
 * whichever field the SDK error exposes (message / responseBody / cause), so
 * match the code and message tolerantly. URLs from upstream errors are never
 * authorization targets; the Connect action navigates to provider Settings.
 */
function detectGatewayAuthRequired(error: unknown, fields: { message: string | null; code: string | null; responseBody: string | null }): GatewayAuthRequired | null {
  const haystack = [fields.message, fields.responseBody, safeStringify(error)].filter(Boolean).join("\n");
  if (!haystack.includes(GATEWAY_AUTH_REQUIRED_ERROR_CODE)) return null;
  for (const candidate of [fields.responseBody, fields.message]) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start));
      const body = recordValue(parsed, "error");
      if (recordValue(body, "code") !== GATEWAY_AUTH_REQUIRED_ERROR_CODE) continue;
      return {
        connectUrl: null,
        message: firstStringValue([body], ["message"]),
      };
    } catch {
      // Not a clean JSON body: retain only the error classification below.
    }
  }
  return {
    connectUrl: null,
    message: fields.code === GATEWAY_AUTH_REQUIRED_ERROR_CODE ? fields.message : null,
  };
}

function errorRecoveryPrompt(kind: OpencodeSessionErrorKind) {
  return kind === "aborted" || kind === "provider-timeout" || kind === "provider-incomplete"
    ? interruptedTaskRecoveryPrompt
    : null;
}

function withAttachmentRecoveryHint(text: string) {
  if (!text.includes("file part media type") || !text.includes("not supported")) return text;
  return `${text}\nAn attached file in this conversation uses a format the model can't read. Revert the conversation to before the attachment was sent, or start a new session.`;
}

function withOpenAiTokenRefreshHint(text: string) {
  if (!/Token refresh failed:\s*401/i.test(text)) return text;
  return "OpenAI couldn’t renew the ChatGPT sign-in for this worker. Retry once. If it happens again, reconnect OpenAI under Connect providers → OpenAI → ChatGPT Pro/Plus.";
}

function normalizeSessionError(text: string) {
  return normalizeErrorText(withOpenAiTokenRefreshHint(withAttachmentRecoveryHint(text)), { cap: 500 }).display;
}

function sessionErrorFields(error: unknown, fallback: string) {
  if (typeof error === "string") {
    return {
      name: null,
      message: error.trim() || fallback,
      status: null,
      provider: null,
      code: null,
      retries: null,
      responseBody: null,
    };
  }
  if (!error || typeof error !== "object") {
    return {
      name: null,
      message: fallback,
      status: null,
      provider: null,
      code: null,
      retries: null,
      responseBody: null,
    };
  }

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  return {
    name: firstStringValue(records, ["name", "type"]),
    message: firstStringValue(records, ["message", "detail", "reason", "error"]),
    status: firstNumberValue(records, ["statusCode", "status"]),
    provider: firstStringValue(records, ["providerID", "providerId", "provider"]),
    code: firstStringValue(records, ["code", "errorCode"]),
    retries: firstNumberValue(records, ["retries", "retryCount"]),
    responseBody: firstStringValue(records, ["responseBody", "body", "response"]),
  };
}

function technicalErrorDetails(error: unknown, fallback: string, fields: ReturnType<typeof sessionErrorFields>) {
  const lines: string[] = [];
  if (fields.name) lines.push(`Error type: ${fields.name}`);
  if (fields.message) lines.push(`Message: ${fields.message}`);
  if (fields.status !== null) lines.push(`Status: ${fields.status}`);
  if (fields.provider) lines.push(`Provider: ${fields.provider}`);
  if (fields.code) lines.push(`Code: ${fields.code}`);
  if (fields.retries !== null) lines.push(`Retries: ${fields.retries}`);
  if (fields.responseBody && fields.responseBody !== fields.message) {
    lines.push(`Response: ${normalizeErrorText(fields.responseBody, { cap: 500 }).display}`);
  }
  if (lines.length > 0) {
    return normalizeErrorText(lines.join("\n"), { cap: 1_500 }).display;
  }

  const serialized = safeStringify(error);
  return normalizeErrorText(serialized && serialized !== "{}" ? serialized : fallback, { cap: 1_500 }).display;
}

export function presentOpencodeSessionError(error: unknown, fallback = "Session failed"): OpencodeSessionErrorPresentation {
  const fields = sessionErrorFields(error, fallback);
  const gatewayAuth = detectGatewayAuthRequired(error, fields);
  const gatewaySelection = safeStringify(error)?.includes("gateway_selection_required") === true;
  const kind = gatewayAuth ? "gateway-auth-required" : gatewaySelection ? "gateway-selection-required" : sessionErrorKind(fields.name, fields.message, fields.code, fields.responseBody);
  const fallbackTitle = normalizeSessionError(fields.message ?? defaultErrorMessage(fields.name, fallback));
  return {
    kind,
    title: errorTitle(kind, fallbackTitle),
    description: errorDescription(kind, gatewayAuth),
    technicalDetails: kind === "gateway-selection-required" ? "Error code: gateway_selection_required\nStatus: 409" : gatewayAuth ? "Error code: openwork_auth_required\nStatus: 401" : technicalErrorDetails(error, fallback, fields),
    recoveryPrompt: errorRecoveryPrompt(kind),
    ...(gatewayAuth ? { connectUrl: gatewayAuth.connectUrl } : {}),
  };
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed") {
  const presentation = presentOpencodeSessionError(error, fallback);
  return presentation.description
    ? `${presentation.title}\n${presentation.description}`
    : presentation.title;
}

export function sessionErrorPresentationFromUIMessage(message: UIMessage): OpencodeSessionErrorPresentation | null {
  const part = message.parts.find((candidate) => candidate.type === "text");
  if (!part || part.type !== "text") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  const sessionError = "sessionError" in metadata
    ? (metadata as { sessionError?: unknown }).sessionError
    : null;
  if (!sessionError || typeof sessionError !== "object") return null;
  const candidate = sessionError as Partial<OpencodeSessionErrorPresentation>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.title !== "string" ||
    !(typeof candidate.description === "string" || candidate.description === null) ||
    typeof candidate.technicalDetails !== "string" ||
    !(typeof candidate.recoveryPrompt === "string" || candidate.recoveryPrompt === null) ||
    !(candidate.connectUrl === undefined || candidate.connectUrl === null || typeof candidate.connectUrl === "string")
  ) {
    return null;
  }
  return candidate as OpencodeSessionErrorPresentation;
}
