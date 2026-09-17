import type { UIMessage } from "ai";

import { safeStringify } from "../../../../app/utils";
import { t } from "@/i18n";
import { normalizeErrorText } from "../../../../lib/error-text";

export type OpencodeSessionErrorKind = "aborted" | "provider-timeout" | "provider-incomplete" | "free-model-limit" | "disk-full" | "database-error" | "gateway-auth-required" | "gateway-selection-required" | "provider-auth" | "budget-exceeded" | "model-unavailable" | "den-disconnected" | "organization-credential-missing" | "generic";
export type OpencodeSessionErrorAction = "connect-provider" | "gateway-selection" | "open-den-models" | "reconnect-den" | "repick-model";

export type OpencodeSessionErrorContext = {
  denDisconnected?: boolean;
  organizationCredentialMissing?: boolean;
  modelUnavailable?: boolean;
};

export type OpencodeSessionErrorPresentation = {
  kind: OpencodeSessionErrorKind;
  title: string;
  description: string | null;
  technicalDetails: string;
  recoveryPrompt: string | null;
  action?: OpencodeSessionErrorAction | null;
  terminal?: boolean;
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
  return Reflect.get(value, key);
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
  status: number | null,
  responseBody: string | null,
): OpencodeSessionErrorKind {
  const searchable = [name, message, code, status === null ? null : String(status), responseBody].filter(Boolean).join(" ");
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
  if (
    name === "ProviderModelNotFoundError" ||
    name === "ModelNotFound" ||
    code === "model_not_found" ||
    code === "provider_model_not_found" ||
    /\b(?:model_not_found|provider_model_not_found)\b/.test(searchable)
  ) {
    return "model-unavailable";
  }
  const budgetStatus = statusFromText(searchable);
  if (
    /\bbudget_exceeded\b/i.test(searchable) ||
    (budgetStatus !== null && [400, 429].includes(budgetStatus) && /\bbudget has been exceeded\b/i.test(searchable))
  ) {
    return "budget-exceeded";
  }
  if (
    name === "ProviderAuthError" ||
    ["authentication_error", "invalid_api_key", "invalid_auth", "credential_missing", "credentials_missing"].includes(code ?? "") ||
    /\b(?:authentication_error|invalid_api_key|invalid_auth|credential_missing|credentials_missing)\b/i.test(searchable) ||
    ([401, 403].includes(statusFromText(searchable) ?? 0) && /\b(?:auth(?:entication|orization)?|credential|api[ _-]?key|unauthorized|forbidden)\b/i.test(searchable))
  ) {
    return "provider-auth";
  }
  return "generic";
}

function statusFromText(text: string) {
  const match = /\b(?:HTTP\s*)?(400|401|403|429)\b/i.exec(text);
  return match?.[1] ? Number(match[1]) : null;
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
  if (kind === "provider-auth") return t("session.error_provider_auth_title");
  if (kind === "budget-exceeded") return t("session.error_budget_exceeded_title");
  if (kind === "model-unavailable") return t("session.error_model_unavailable_title");
  if (kind === "den-disconnected") return t("session.error_den_disconnected_title");
  if (kind === "organization-credential-missing") return t("session.error_organization_credential_missing_title");
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
  if (kind === "provider-auth") return t("session.error_provider_auth_description");
  if (kind === "budget-exceeded") return t("session.error_budget_exceeded_description");
  if (kind === "model-unavailable") return t("session.error_model_unavailable_description");
  if (kind === "den-disconnected") return t("session.error_den_disconnected_description");
  if (kind === "organization-credential-missing") return t("session.error_organization_credential_missing_description");
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

function withoutStackTrace(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+(?:async\s+)?\S+/i.test(line))
    .join("\n")
    .trim();
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
  if (fields.message) lines.push(`Message: ${withoutStackTrace(fields.message)}`);
  if (fields.status !== null) lines.push(`Status: ${fields.status}`);
  if (fields.provider) lines.push(`Provider: ${fields.provider}`);
  if (fields.code) lines.push(`Code: ${fields.code}`);
  if (fields.retries !== null) lines.push(`Retries: ${fields.retries}`);
  if (fields.responseBody && fields.responseBody !== fields.message) {
    lines.push(`Response: ${normalizeErrorText(withoutStackTrace(fields.responseBody), { cap: 500 }).display}`);
  }
  if (lines.length > 0) {
    return normalizeErrorText(lines.join("\n"), { cap: 1_500 }).display;
  }

  const serialized = safeStringify(error);
  return normalizeErrorText(withoutStackTrace(serialized && serialized !== "{}" ? serialized : fallback), { cap: 1_500 }).display;
}

function errorAction(kind: OpencodeSessionErrorKind): OpencodeSessionErrorAction | null {
  if (kind === "gateway-auth-required" || kind === "provider-auth") return "connect-provider";
  if (kind === "gateway-selection-required") return "gateway-selection";
  if (kind === "model-unavailable" || kind === "budget-exceeded") return "repick-model";
  if (kind === "den-disconnected") return "reconnect-den";
  if (kind === "organization-credential-missing") return "open-den-models";
  return null;
}

function isProviderFailure(kind: OpencodeSessionErrorKind) {
  return ["generic", "provider-auth", "provider-timeout", "gateway-auth-required", "budget-exceeded", "model-unavailable"].includes(kind);
}

export function resolveOpencodeSessionErrorPresentation(
  presentation: OpencodeSessionErrorPresentation,
  context?: OpencodeSessionErrorContext,
): OpencodeSessionErrorPresentation {
  if (!isProviderFailure(presentation.kind)) return presentation;
  const kind: OpencodeSessionErrorKind = context?.denDisconnected
    ? "den-disconnected"
    : context?.organizationCredentialMissing
      ? "organization-credential-missing"
      : context?.modelUnavailable
        ? "model-unavailable"
        : presentation.kind;
  if (kind === presentation.kind) return presentation;
  return {
    ...presentation,
    kind,
    title: errorTitle(kind, presentation.title),
    description: errorDescription(kind, null),
    action: errorAction(kind),
    terminal: ["provider-auth", "budget-exceeded", "model-unavailable", "den-disconnected", "organization-credential-missing"].includes(kind),
  };
}

export function isTerminalProviderRetry(message: string, context?: OpencodeSessionErrorContext) {
  if (context?.denDisconnected || context?.organizationCredentialMissing || context?.modelUnavailable) return true;
  const kind = sessionErrorKind(null, message, null, null, null);
  return kind === "provider-auth" || kind === "budget-exceeded" || kind === "model-unavailable";
}

export function presentOpencodeSessionError(error: unknown, fallback = "Session failed"): OpencodeSessionErrorPresentation {
  const fields = sessionErrorFields(error, fallback);
  const gatewayAuth = detectGatewayAuthRequired(error, fields);
  const gatewaySelection = safeStringify(error)?.includes("gateway_selection_required") === true;
  const kind = gatewayAuth ? "gateway-auth-required" : gatewaySelection ? "gateway-selection-required" : sessionErrorKind(fields.name, fields.message, fields.code, fields.status, fields.responseBody);
  const fallbackTitle = normalizeSessionError(fields.message ?? defaultErrorMessage(fields.name, fallback));
  return resolveOpencodeSessionErrorPresentation({
    kind,
    title: errorTitle(kind, fallbackTitle),
    description: errorDescription(kind, gatewayAuth),
    technicalDetails: kind === "gateway-selection-required" ? "Error code: gateway_selection_required\nStatus: 409" : gatewayAuth ? "Error code: openwork_auth_required\nStatus: 401" : technicalErrorDetails(error, fallback, fields),
    recoveryPrompt: errorRecoveryPrompt(kind),
    action: errorAction(kind),
    terminal: ["provider-auth", "budget-exceeded", "model-unavailable"].includes(kind),
    ...(gatewayAuth ? { connectUrl: gatewayAuth.connectUrl } : {}),
  });
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
  const sessionError = "sessionError" in metadata ? Reflect.get(metadata, "sessionError") : null;
  if (!sessionError || typeof sessionError !== "object") return null;
  const kind = recordValue(sessionError, "kind");
  const title = recordValue(sessionError, "title");
  const description = recordValue(sessionError, "description");
  const technicalDetails = recordValue(sessionError, "technicalDetails");
  const recoveryPrompt = recordValue(sessionError, "recoveryPrompt");
  const connectUrl = recordValue(sessionError, "connectUrl");
  const action = recordValue(sessionError, "action");
  const terminal = recordValue(sessionError, "terminal");
  if (
    typeof kind !== "string" || !isSessionErrorKind(kind) ||
    typeof title !== "string" ||
    !(typeof description === "string" || description === null) ||
    typeof technicalDetails !== "string" ||
    !(typeof recoveryPrompt === "string" || recoveryPrompt === null) ||
    !(connectUrl === undefined || connectUrl === null || typeof connectUrl === "string") ||
    !(action === undefined || action === null || isSessionErrorAction(action)) ||
    !(terminal === undefined || typeof terminal === "boolean")
  ) {
    return null;
  }
  return {
    kind,
    title,
    description,
    technicalDetails,
    recoveryPrompt,
    ...(connectUrl !== undefined ? { connectUrl } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

function isSessionErrorKind(value: string): value is OpencodeSessionErrorKind {
  return ["aborted", "provider-timeout", "provider-incomplete", "free-model-limit", "disk-full", "database-error", "gateway-auth-required", "gateway-selection-required", "provider-auth", "budget-exceeded", "model-unavailable", "den-disconnected", "organization-credential-missing", "generic"].includes(value);
}

function isSessionErrorAction(value: unknown): value is OpencodeSessionErrorAction {
  return typeof value === "string" && ["connect-provider", "gateway-selection", "open-den-models", "reconnect-den", "repick-model"].includes(value);
}
