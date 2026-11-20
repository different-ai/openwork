import { denApiCredentials, denBrowserEndpoint } from "../../app/(den)/_lib/den-api-origin";

const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";

/**
 * Keeps password-login bearer credentials alongside the web-host session
 * cookie; the same-origin browser proxy forwards both to Den API.
 */
export function withStoredBearer(headers: Record<string, string>): Record<string, string> {
  if (typeof window === "undefined") return headers;
  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
    return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
  } catch {
    // Cookie sign-in still works when browser storage is unavailable.
    return headers;
  }
}

export type AdminAccess = "ready" | "signed-out" | "forbidden" | "error";

export type AdminResult<T> =
  | { access: "ready"; data: T }
  | { access: Exclude<AdminAccess, "ready">; message: string; status?: number; code?: string };

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return fallback;
}

function responseCode(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  return undefined;
}

const FORBIDDEN_MESSAGES: Record<string, string> = {
  forbidden: "This account is not on the OpenWork admin allowlist.",
  admin_email_unverified: "This account's email address is not verified. Verify it, then retry.",
  admin_email_required: "This account has no email address to check against the admin allowlist.",
};

/** Why Den refused an admin request with 403: the reason for its error code, else its own message. */
export function adminForbiddenMessage(payload: unknown): string {
  const code = responseCode(payload);
  if (code && Object.hasOwn(FORBIDDEN_MESSAGES, code)) return FORBIDDEN_MESSAGES[code];
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" && payload.message) return payload.message;
  return "This account cannot open this admin page.";
}

/** Email of the signed-in account, so an access screen can say which account was refused. Null when unknown. */
export async function requestSignedInEmail(signal?: AbortSignal): Promise<string | null> {
  try {
    const endpoint = denBrowserEndpoint("/v1/me");
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: denApiCredentials(endpoint),
      signal,
      headers: withStoredBearer({ Accept: "application/json" }),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const user = payload && typeof payload === "object" && "user" in payload ? payload.user : null;
    const email = user && typeof user === "object" && "email" in user ? user.email : null;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

/** GET an admin endpoint and map the response to the access states every admin page shows. */
export async function requestAdmin<T>(path: string, parse: (payload: unknown) => T | null, signal?: AbortSignal): Promise<AdminResult<T>> {
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "GET",
    cache: "no-store",
    credentials: denApiCredentials(endpoint),
    signal,
    headers: withStoredBearer({ Accept: "application/json" }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (response.status === 401) return { access: "signed-out", message: "Sign in with an OpenWork admin account to continue." };
  if (response.status === 403) return { access: "forbidden", message: adminForbiddenMessage(payload), status: 403, code: responseCode(payload) };
  if (!response.ok) return { access: "error", message: errorMessage(payload, `The request failed with status ${response.status}.`), status: response.status, code: responseCode(payload) };
  const data = parse(payload);
  return data === null ? { access: "error", message: "The server returned data this page does not understand." } : { access: "ready", data };
}

/** PUT/POST JSON to an admin endpoint; returns the parsed payload or the server's error message. */
export async function sendAdmin(path: string, method: "PUT" | "POST" | "PATCH", body?: unknown, signal?: AbortSignal): Promise<{ ok: true; payload: unknown } | { ok: false; message: string; status: number; code?: string; retryAfterSeconds?: number }> {
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method,
    credentials: denApiCredentials(endpoint),
    signal,
    headers: withStoredBearer(body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    const retryAfterSeconds = seconds !== null && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3_600 ? seconds : undefined;
    const message = response.status === 403 ? adminForbiddenMessage(payload) : errorMessage(payload, `The request failed with status ${response.status}.`);
    return { ok: false, message, status: response.status, code: responseCode(payload), retryAfterSeconds };
  }
  return { ok: true, payload };
}
