import type { Breadcrumb, Event } from "@sentry/nextjs";
import type { JsonObject, JsonValue } from "@openwork-ee/utils/observability";

const redacted = "[redacted]";
const redactedQuery = "[redacted-query]";
const sensitiveKeyPattern = /(authorization|cookie|credential|secret|token|password|passwd|api[_-]?key|session|set-cookie|csrf|jwt|bearer)/iu;
const sensitiveContainerKeyPattern = /(^|[_.-])(body|cookies?|data|headers?|payload|query|query_string|raw|request_body|response_body|search)([_.-]|$)/iu;

export type UnknownRecord = {
  readonly [key: string]: unknown;
};

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key) || sensitiveContainerKeyPattern.test(key);
}

export function shouldRedactTelemetryKey(key: string): boolean {
  return isSensitiveKey(key);
}

export function scrubText(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/giu, `$1?${redactedQuery}`)
    .replace(/(\/[A-Za-z0-9._~!$&()*+,;=:@%-][^\s"'<>?]*)\?[^\s"'<>]*/gu, `$1?${redactedQuery}`)
    .replace(/(["'])(authorization|cookie|credential|secret|token|password|passwd|api[_-]?key|session|set-cookie|csrf|jwt|bearer)(["']\s*:\s*)(["'])[^"']*\4/giu, `$1$2$3$4${redacted}$4`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${redacted}`)
    .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/giu, `Basic ${redacted}`)
    .replace(/\b(token|password|secret|api[_-]?key|session|cookie|body|payload|request_body|response_body)=([^\s&;]+)/giu, `$1=${redacted}`)
    .replace(/\b(body|payload|request_body|response_body):\s*[^\n\r]+/giu, `$1: ${redacted}`)
    .replace(/\b(cookie|set-cookie|authorization|x-api-key):\s*[^\n\r]+/giu, `$1: ${redacted}`);
}

function scrubJsonValue(key: string, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (isSensitiveKey(key)) return redacted;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubJsonValue(key, item) ?? null);
  if (typeof value === "object" && value !== null) return scrubLogFields(value);
  return value;
}

function scrubUnknownValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return redacted;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubUnknownValue(key, item));
  if (isUnknownRecord(value)) return scrubUnknownRecord(value);
  return value;
}

export function scrubLogFields(fields: JsonObject | undefined): JsonObject | undefined {
  if (fields === undefined) return undefined;

  const scrubbed: Record<string, JsonValue | undefined> = {};
  for (const [key, value] of Object.entries(fields)) {
    scrubbed[key] = scrubJsonValue(key, value);
  }
  return scrubbed;
}

export function scrubUnknownRecord(record: object | undefined): UnknownRecord | undefined {
  if (record === undefined) return undefined;

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    scrubbed[key] = scrubUnknownValue(key, value);
  }
  return scrubbed;
}

function scrubObject<T extends object>(value: T): T {
  return {
    ...value,
    ...scrubUnknownRecord(value),
  };
}

function scrubSentryHeaders(headers: NonNullable<Event["request"]>["headers"]): NonNullable<Event["request"]>["headers"] {
  return headers === undefined ? undefined : {};
}

function scrubSentryRequest(request: Event["request"]): Event["request"] {
  if (request === undefined) return undefined;

  const { cookies, data, env, headers, query_string, ...safeRequest } = request;
  return {
    ...safeRequest,
    url: request.url === undefined ? undefined : scrubText(request.url),
    headers: scrubSentryHeaders(headers),
  };
}

function isBreadcrumb(value: Breadcrumb | null): value is Breadcrumb {
  return value !== null;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  return {
    ...breadcrumb,
    ...scrubUnknownRecord(breadcrumb),
    category: breadcrumb.category === undefined ? undefined : scrubText(breadcrumb.category),
    data: scrubUnknownRecord(breadcrumb.data),
    message: breadcrumb.message === undefined ? undefined : scrubText(breadcrumb.message),
  };
}

export function scrubSentrySpan<T extends object>(span: T): T {
  return scrubObject(span);
}

type SentryException = NonNullable<NonNullable<Event["exception"]>["values"]>[number];
type SentryThread = NonNullable<NonNullable<Event["threads"]>["values"]>[number];

function scrubSentryException(exception: SentryException): SentryException {
  return scrubObject(exception);
}

function scrubSentryExceptions(exception: Event["exception"]): Event["exception"] {
  if (exception === undefined) return undefined;

  return {
    ...scrubObject(exception),
    values: exception.values === undefined ? undefined : exception.values.map(scrubSentryException),
  };
}

function scrubSentryLogEntry(logentry: Event["logentry"]): Event["logentry"] {
  return logentry === undefined ? undefined : scrubObject(logentry);
}

function scrubSentryContexts(contexts: Event["contexts"]): Event["contexts"] {
  return contexts === undefined ? undefined : scrubObject(contexts);
}

function scrubSentryThread(thread: SentryThread): SentryThread {
  return scrubObject(thread);
}

function scrubSentryThreads(threads: Event["threads"]): Event["threads"] {
  if (threads === undefined) return undefined;

  return {
    ...scrubObject(threads),
    values: threads.values.map(scrubSentryThread),
  };
}

export function scrubSentryEvent<T extends Event>(event: T): T | null {
  const nextEvent = { ...event };
  nextEvent.message = event.message === undefined ? undefined : scrubText(event.message);
  nextEvent.transaction = event.transaction === undefined ? undefined : scrubText(event.transaction);
  nextEvent.request = scrubSentryRequest(event.request);
  nextEvent.user = undefined;

  if (event.contexts !== undefined) {
    nextEvent.contexts = scrubSentryContexts(event.contexts);
  }
  if (event.exception !== undefined) {
    nextEvent.exception = scrubSentryExceptions(event.exception);
  }
  if (event.logentry !== undefined) {
    nextEvent.logentry = scrubSentryLogEntry(event.logentry);
  }
  if (event.threads !== undefined) {
    nextEvent.threads = scrubSentryThreads(event.threads);
  }
  if (event.breadcrumbs !== undefined) {
    nextEvent.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb).filter(isBreadcrumb);
  }
  if (event.extra !== undefined) {
    nextEvent.extra = scrubUnknownRecord(event.extra);
  }
  if (event.tags !== undefined) {
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(event.tags)) {
      tags[key] = scrubText(String(value));
    }
    nextEvent.tags = tags;
  }

  return nextEvent;
}
