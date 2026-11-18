import type { ErrorEvent, Event, EventHint } from "@sentry/nextjs";
import { z } from "zod";

export const scimProxyFailureDiagnostic = "den_web_scim_fetch_failure";
export const scimProxyFailureMessage = "den-web SCIM upstream fetch failed";

const errorNames = z.enum(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "unknown"]);
const causeCodes = z.enum([
  "UND_ERR_NOT_SUPPORTED", "UND_ERR_INVALID_ARG", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_ABORTED", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "unknown",
]);
const scimPaths = z.enum([
  "/api/auth/scim/v2", "/api/auth/scim/v2/Users", "/api/auth/scim/v2/Users/:id",
  "/api/auth/scim/v2/Groups", "/api/auth/scim/v2/Groups/:id",
  "/api/auth/scim/v2/Schemas", "/api/auth/scim/v2/Schemas/:id",
  "/api/auth/scim/v2/ResourceTypes", "/api/auth/scim/v2/ResourceTypes/:id",
  "/api/auth/scim/v2/ServiceProviderConfig", "/api/auth/scim/v2/Bulk",
  "/api/auth/scim/v2/Me", "/api/auth/scim/v2/:path",
]);
const methods = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fieldsSchema = z.object({
  route_prefix: z.literal("/api/auth"),
  method: methods,
  upstream_path: scimPaths,
  request_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  duration_ms: count,
  observed_bytes: count,
  error_name: errorNames,
  cause_code: causeCodes,
  failure_class: z.enum([
    "client_abort", "deadline", "unsupported_request", "invalid_request", "timeout",
    "dns", "connection", "tls", "aborted", "type_error", "unknown",
    "expect_header_unsupported", "detached_body_buffer",
  ]),
  has_expect: z.boolean(),
  expect_100_continue: z.boolean(),
});

export type ScimProxyFailureFields = z.infer<typeof fieldsSchema>;

export function canonicalScimProxyPath(routePrefix: string, upstreamPrefix: string, targetPath: string): string | null {
  if (routePrefix !== "/api/auth" || upstreamPrefix !== "api/auth") return null;
  if (targetPath !== "scim/v2" && !targetPath.startsWith("scim/v2/")) return null;
  if (targetPath.length > 2048) return "/api/auth/scim/v2/:path";
  // No identifiers, arbitrary suffixes, or query text survive into telemetry.
  const parts = targetPath.slice("scim/v2".length).split("/").filter(Boolean);
  if (parts.length > 2) return "/api/auth/scim/v2/:path";
  const resource = parts[0];
  const candidate = `/api/auth/scim/v2${resource ? `/${resource}` : ""}${parts.length > 1 ? "/:id" : ""}`;
  const parsed = scimPaths.safeParse(candidate);
  return parsed.success ? parsed.data : "/api/auth/scim/v2/:path";
}

function errorField(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    // Do not invoke exception getters or stringify arbitrary thrown values.
    const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    return field;
  } catch {
    return undefined;
  }
}

export function classifyScimProxyFailure(error: unknown, abortCause: "client" | "deadline" | "downstream" | null) {
  let errorName: z.infer<typeof errorNames> = "unknown";
  try {
    const name = errorNames.safeParse(errorField(error, "name"));
    if (name.success) errorName = name.data;
    else if (error instanceof TypeError) errorName = "TypeError";
    else if (error instanceof RangeError) errorName = "RangeError";
    else if (error instanceof Error) errorName = "Error";
  } catch {
    // Hostile proxies must not interfere with the original failure response.
  }
  let causeCode: z.infer<typeof causeCodes> = "unknown";
  let knownFailure: "expect_header_unsupported" | "detached_body_buffer" | undefined;
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    // Exact known messages select static labels; the message itself never leaves
    // this function. Do not classify arbitrary text by substring or export it.
    const message = errorField(current, "message");
    if (message === "expect header not supported") knownFailure = "expect_header_unsupported";
    if (message === "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer") knownFailure = "detached_body_buffer";
    const parsed = causeCodes.safeParse(errorField(current, "code"));
    if (causeCode === "unknown" && parsed.success && parsed.data !== "unknown") {
      causeCode = parsed.data;
    }
    current = errorField(current, "cause");
  }
  let failureClass: ScimProxyFailureFields["failure_class"] = "unknown";
  switch (causeCode) {
    case "UND_ERR_NOT_SUPPORTED": failureClass = "unsupported_request"; break;
    case "UND_ERR_INVALID_ARG":
    case "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH": failureClass = "invalid_request"; break;
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
    case "ETIMEDOUT": failureClass = "timeout"; break;
    case "ENOTFOUND":
    case "EAI_AGAIN": failureClass = "dns"; break;
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EPIPE":
    case "UND_ERR_SOCKET": failureClass = "connection"; break;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID": failureClass = "tls"; break;
    case "UND_ERR_ABORTED": failureClass = "aborted"; break;
    default:
      if (errorName === "TypeError") failureClass = "type_error";
      else if (errorName === "AbortError") failureClass = "aborted";
      else if (errorName === "TimeoutError") failureClass = "timeout";
  }
  if (knownFailure !== undefined) failureClass = knownFailure;
  if (abortCause === "client") failureClass = "client_abort";
  if (abortCause === "deadline") failureClass = "deadline";
  return { error_name: errorName, cause_code: causeCode, failure_class: failureClass };
}

export async function scimProxyFailureFields(input: {
  error: unknown;
  abortCause: "client" | "deadline" | "downstream" | null;
  method: string;
  path: string;
  referenceId: string;
  durationMs: number;
  observedBytes: number;
  expect: string | null;
}): Promise<ScimProxyFailureFields> {
  // Incoming reference IDs are arbitrary client text, not a trusted log field.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.referenceId));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const method = methods.safeParse(input.method);
  return fieldsSchema.parse({
    ...classifyScimProxyFailure(input.error, input.abortCause),
    route_prefix: "/api/auth",
    method: method.success ? method.data : "OTHER",
    upstream_path: input.path,
    request_id: `sha256:${hash}`,
    duration_ms: Math.max(0, input.durationMs),
    observed_bytes: input.observedBytes,
    has_expect: input.expect !== null,
    expect_100_continue: input.expect !== null && input.expect.length <= 256
      && input.expect.trim().toLowerCase() === "100-continue",
  });
}

export function scimProxyFailureEvent(fields: ScimProxyFailureFields): ErrorEvent {
  return {
    type: undefined,
    level: "error",
    message: scimProxyFailureMessage,
    exception: { values: [{ type: "ScimProxyFetchFailure", value: scimProxyFailureMessage }] },
    tags: { diagnostic: scimProxyFailureDiagnostic },
    fingerprint: [scimProxyFailureDiagnostic, fields.failure_class, fields.cause_code],
    extra: fields,
  };
}

export function scrubScimProxyFailureEvent(event: Event, hint: EventHint): ErrorEvent | null {
  // v10.64 merges global/isolation scopes and runs RequestData before beforeSend.
  // Rebuild instead of spreading: even SDK metadata can hold a URL/transaction.
  hint.attachments = [];
  const fields = fieldsSchema.safeParse(event.extra);
  if (!fields.success) return null;
  return {
    ...scimProxyFailureEvent(fields.data),
    event_id: event.event_id && /^[a-f0-9]{32}$/.test(event.event_id) ? event.event_id : undefined,
    timestamp: typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : undefined,
  };
}
