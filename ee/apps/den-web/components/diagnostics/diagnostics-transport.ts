import type { OrgDiagnostics } from "@openwork/types/den/diagnostics";
import { requestJson } from "../../app/(den)/_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../app/(den)/_lib/org-scope";
import { DIAGNOSTICS_CHECK_PATH, DIAGNOSTICS_PATH, parseOrgDiagnostics, retryAfterSeconds } from "./diagnostics-data";

export type DiagnosticsFailure = "signed_out" | "forbidden" | "unsupported" | "error";

export type DiagnosticsReadResult =
  | { ok: true; data: OrgDiagnostics }
  | { ok: false; failure: DiagnosticsFailure; status: number };

export type DiagnosticsCheckResult =
  | { ok: true; rateLimited: boolean; retryAfterSeconds?: number; data: OrgDiagnostics | null }
  | { ok: false; failure: DiagnosticsFailure; status: number };

/** Server messages and bodies never reach rendering state; only the status class does. */
function failureFor(status: number): DiagnosticsFailure {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 404) return "unsupported";
  return "error";
}

/** Reads the cached report for one organization; never starts live checks. */
export async function readOrgDiagnostics(orgId: string, signal?: AbortSignal): Promise<DiagnosticsReadResult> {
  signal?.throwIfAborted();
  const { response, payload } = await requestJson(DIAGNOSTICS_PATH, {
    method: "GET", cache: "no-store", signal, headers: { [ORG_SCOPE_HEADER]: orgId },
  }, 15_000);
  signal?.throwIfAborted();
  // `?strict=1` callers get 503 with the same body; this page never asks for strict mode.
  if (!response.ok) return { ok: false, failure: failureFor(response.status), status: response.status };
  const data = parseOrgDiagnostics(payload);
  return data ? { ok: true, data } : { ok: false, failure: "error", status: response.status };
}

/** Starts the checks the caller may run. Bodyless: the browser can't choose targets or credentials. */
export async function startOrgDiagnosticsCheck(orgId: string, signal?: AbortSignal): Promise<DiagnosticsCheckResult> {
  signal?.throwIfAborted();
  const { response, payload } = await requestJson(DIAGNOSTICS_CHECK_PATH, {
    method: "POST", signal, headers: { [ORG_SCOPE_HEADER]: orgId },
  }, 15_000);
  signal?.throwIfAborted();
  if (response.status === 429) {
    return { ok: true, rateLimited: true, retryAfterSeconds: retryAfterSeconds(response.headers.get("Retry-After")), data: parseOrgDiagnostics(payload) };
  }
  if (!response.ok) return { ok: false, failure: failureFor(response.status), status: response.status };
  return { ok: true, rateLimited: false, data: parseOrgDiagnostics(payload) };
}
