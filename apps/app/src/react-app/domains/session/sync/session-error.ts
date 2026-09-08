import type { UIMessage } from "ai";

import { safeStringify } from "../../../../app/utils";
import { normalizeErrorText } from "../../../../lib/error-text";
import type { InferenceUpgradeReason } from "@/app/lib/inference-access";
import { desktopFreeAccessStatusSchema, desktopFreeNotice, desktopFreeStatusFromError } from "@/app/lib/inference-access";
import type { DesktopFreeAccessStatus } from "@openwork/types/desktop-free-access";

export type OpencodeSessionErrorKind = "aborted" | "provider-timeout" | "free-model-limit" | "disk-full" | "database-error" | "inference-upgrade" | "desktop-free-access" | "generic";

export type OpencodeSessionErrorPresentation = {
  kind: OpencodeSessionErrorKind;
  title: string;
  description: string | null;
  technicalDetails: string;
  recoveryPrompt: string | null;
  inference?: { reason: InferenceUpgradeReason; resetsAt: string | null };
  desktopFree?: DesktopFreeAccessStatus;
};

// Decode only structured engine envelopes, never codes mentioned in prose or
// arbitrary provider payload fields. Bound both depth and JSON size.
function errorRecords(value: unknown, depth = 0): unknown[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    if (value.length > 65_536 || !value.trimStart().startsWith("{")) return [];
    try { return errorRecords(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (!value || typeof value !== "object") return [];
  return [value, ...["data", "cause", "error", "message"].flatMap((key) => errorRecords(recordValue(value, key), depth + 1))];
}

export function structuredInferenceError(error: unknown, providerID?: string): OpencodeSessionErrorPresentation["inference"] {
  const records = errorRecords(error);
  const provider = providerID ?? firstStringValue(records, ["providerID", "providerId", "provider"]);
  if (provider !== "openwork" || firstNumberValue(records, ["statusCode", "status"]) !== 402) return undefined;
  const body = records.flatMap((record) => errorRecords(recordValue(record, "responseBody")));
  const reason = firstStringValue([...body, ...records], ["code", "errorCode"]);
  if (reason !== "free_allowance_exhausted" && reason !== "managed_model_requires_upgrade") return undefined;
  const reset = firstStringValue([...body, ...records], ["resetsAt"]);
  return { reason, resetsAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null };
}

export function latestAssistantProvider(messages: UIMessage[]): string | undefined {
  const message = messages.findLast((item) => !item.id.startsWith("session-error:") && (item.role === "assistant" || item.role === "user"));
  if (message?.role !== "assistant") return undefined;
  const provider = recordValue(recordValue(message?.metadata, "opencode"), "providerID");
  return typeof provider === "string" ? provider : undefined;
}

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
  if (responseBody?.includes("FreeUsageLimitError") || message?.includes("FreeUsageLimitError")) {
    return "free-model-limit";
  }
  return "generic";
}

function errorTitle(kind: OpencodeSessionErrorKind, fallback: string) {
  if (kind === "disk-full") return "Not enough disk space";
  if (kind === "database-error") return "OpenWork couldn’t access its saved data";
  if (kind === "aborted") return "Task interrupted";
  if (kind === "provider-timeout") return "Provider did not respond in time";
  if (kind === "free-model-limit") return "The free starter model is busy right now";
  return fallback;
}

function errorDescription(kind: OpencodeSessionErrorKind) {
  if (kind === "disk-full") {
    return "The device running this task has run out of storage. Free up some disk space, then try again. If this is a cloud workspace, ask its administrator to check the storage.";
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
  if (kind === "free-model-limit") {
    return "Too many people are using the free model at once. Wait a few minutes and try again, or connect your own model provider in Settings → AI Providers to keep working.";
  }
  return null;
}

function errorRecoveryPrompt(kind: OpencodeSessionErrorKind) {
  return kind === "aborted" || kind === "provider-timeout"
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

export function presentOpencodeSessionError(error: unknown, fallback = "Session failed", providerID?: string): OpencodeSessionErrorPresentation {
  const provider = providerID ?? firstStringValue(errorRecords(error), ["providerID", "providerId", "provider"]);
  const desktopFree = provider === "openwork-free" ? desktopFreeStatusFromError(error) : null;
  if (desktopFree) {
    const notice = desktopFreeNotice(desktopFree, false);
    return { kind: "desktop-free-access", title: notice.title, description: notice.body,
      technicalDetails: `Provider: openwork-free\nCode: ${desktopFree.code ?? "unavailable"}`,
      recoveryPrompt: null, desktopFree };
  }
  const inference = structuredInferenceError(error, providerID);
  if (inference) return {
    kind: "inference-upgrade",
    title: inference.reason === "free_allowance_exhausted" ? "Your free Luna allowance is used up" : "This model requires OpenWork Models",
    description: inference.reason === "free_allowance_exhausted"
      ? "You've used this week's free allowance. Wait for the reset, upgrade, or choose another provider. Output already produced is kept."
      : "Free access includes standard Luna. Upgrade to use this managed model, or choose another provider. Output already produced is kept.",
    technicalDetails: `Status: 402\nProvider: openwork\nCode: ${inference.reason}`,
    recoveryPrompt: null,
    inference,
  };
  const structured = errorRecords(error)[0];
  if (structured) error = structured;
  const fields = sessionErrorFields(error, fallback);
  const kind = sessionErrorKind(fields.name, fields.message, fields.code, fields.responseBody);
  const fallbackTitle = normalizeSessionError(fields.message ?? defaultErrorMessage(fields.name, fallback));
  return {
    kind,
    title: errorTitle(kind, fallbackTitle),
    description: errorDescription(kind),
    technicalDetails: technicalErrorDetails(error, fallback, fields),
    recoveryPrompt: errorRecoveryPrompt(kind),
  };
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed", providerID?: string) {
  const presentation = presentOpencodeSessionError(error, fallback, providerID);
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
  if (candidate.desktopFree !== undefined && !desktopFreeAccessStatusSchema.safeParse(candidate.desktopFree).success) return null;
  const inference = candidate.inference;
  if (inference !== undefined && (!inference || typeof inference !== "object"
    || (inference.reason !== "free_allowance_exhausted" && inference.reason !== "managed_model_requires_upgrade")
    || !(inference.resetsAt === null || typeof inference.resetsAt === "string"))) return null;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.title !== "string" ||
    !(typeof candidate.description === "string" || candidate.description === null) ||
    typeof candidate.technicalDetails !== "string" ||
    !(typeof candidate.recoveryPrompt === "string" || candidate.recoveryPrompt === null)
  ) {
    return null;
  }
  return candidate as OpencodeSessionErrorPresentation;
}
