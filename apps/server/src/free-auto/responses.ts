import type { ManagedModelRecommendation } from "@openwork/types/den/inference";
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_SESSION_POW_MAX_BITS, DESKTOP_FREE_SESSION_POW_MAX_ROUNDS, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_STATUS_PATH,
  type DesktopFreeAccessStatus, type DesktopFreeSession, type SessionPowParams,
} from "@openwork/free-auto";
import { isRecord } from "./http.js";

/** Parsers for what the Gateway and Den send back. Anything unexpected is rejected, never guessed at. */

function isRecommendation(value: unknown): value is ManagedModelRecommendation {
  return isRecord(value) && typeof value.modelID === "string" && typeof value.displayName === "string"
    && typeof value.providerName === "string" && typeof value.summary === "string"
    && typeof value.recommended === "boolean" && typeof value.rank === "number" && Number.isFinite(value.rank)
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => typeof capability === "string");
}

/**
 * A validated status, merged over `base`. A ready status must carry an
 * allowance; guests also need a version floor, because the Gateway version-gates
 * guests while members use their Models key on /api/v1, which is not gated.
 */
export function parseStatus(payload: unknown, base: DesktopFreeAccessStatus, member = false): DesktopFreeAccessStatus {
  if (!isRecord(payload)) throw new Error("Invalid desktop free status.");
  const allowance = payload.allowance;
  let validatedAllowance: DesktopFreeAccessStatus["allowance"] = null;
  if (isRecord(allowance) && typeof allowance.limitUsd === "number" && typeof allowance.usedUsd === "number"
    && typeof allowance.reservedUsd === "number" && typeof allowance.remainingUsd === "number" && typeof allowance.resetsAt === "string"
    && Number.isFinite(Date.parse(allowance.resetsAt))
    && [allowance.limitUsd, allowance.usedUsd, allowance.reservedUsd, allowance.remainingUsd].every((value) => Number.isFinite(value) && value >= 0)) {
    validatedAllowance = { limitUsd: allowance.limitUsd, usedUsd: allowance.usedUsd, reservedUsd: allowance.reservedUsd, remainingUsd: allowance.remainingUsd, resetsAt: allowance.resetsAt };
  }
  const state = payload.state;
  if (state !== "ready" && state !== "update_required" && state !== "unavailable" && state !== "exhausted") throw new Error("Invalid desktop free status state.");
  if (state === "ready" && (!validatedAllowance || (!member && typeof payload.minimumVersion !== "string"))) throw new Error("Incomplete desktop free status.");
  return {
    ...base, state, code: typeof payload.code === "string" ? payload.code : null,
    minimumVersion: typeof payload.minimumVersion === "string" ? payload.minimumVersion : null,
    allowance: validatedAllowance,
    ...(Array.isArray(payload.catalog) ? { catalog: payload.catalog.filter(isRecommendation) } : {}),
    // Den's organization Auto pin travels with status so an admin unpin reaches native pickers.
    ...(typeof payload.defaultPinned === "boolean" ? { defaultPinned: payload.defaultPinned } : {}),
  };
}
const EXHAUSTED_CODES = ["anonymous_limit_exceeded", "anonymous_reservation_does_not_fit", "free_allowance_exhausted"];
/** The status a gateway rejection implies. */
export function statusFromRejection(payload: Record<string, unknown>, base: DesktopFreeAccessStatus): DesktopFreeAccessStatus {
  const code = typeof payload.code === "string" ? payload.code : "anonymous_unavailable";
  return { ...base, code,
    state: code === "desktop_update_required" ? "update_required" : EXHAUSTED_CODES.includes(code) ? "exhausted" : "unavailable",
    minimumVersion: typeof payload.minimumVersion === "string" ? payload.minimumVersion : null,
  };
}
export function parseGuestSession(payload: unknown, now = Date.now()): DesktopFreeSession {
  if (!isRecord(payload) || typeof payload.token !== "string" || !payload.token.trim()
    || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now
    || payload.model !== DESKTOP_FREE_MODEL_ID) throw new Error("Invalid desktop free session response.");
  return { token: payload.token, expiresAt: payload.expiresAt, model: payload.model };
}
/** More proof of work the gateway asked for, if it is a valid request to do more than `current`. */
export function requestedSessionPow(payload: Record<string, unknown>, current: SessionPowParams): SessionPowParams | null {
  if (payload.code !== "session_pow_required" || typeof payload.bits !== "number") return null;
  const bits = payload.bits, rounds = typeof payload.rounds === "number" ? payload.rounds : current.rounds;
  if (!Number.isSafeInteger(bits) || !Number.isSafeInteger(rounds) || bits > DESKTOP_FREE_SESSION_POW_MAX_BITS
    || rounds < 1 || rounds > DESKTOP_FREE_SESSION_POW_MAX_ROUNDS || (bits <= current.bits && rounds === current.rounds)) return null;
  return { bits, rounds };
}
/** The member's Auto key from Den's credential response, checked against the Gateway it must point at. */
export function parseMemberCredential(payload: unknown, origin: string): string {
  const credential = isRecord(payload) ? payload.credential : null;
  if (!isRecord(credential) || typeof credential.apiKey !== "string" || !/^ow_inf_[A-Za-z0-9_-]{43}$/.test(credential.apiKey)
    || credential.modelID !== DESKTOP_FREE_MODEL_ID
    || credential.baseURL !== `${origin}${MEMBER_FREE_MODELS_PATH.slice(0, -"/models".length)}`
    || credential.statusURL !== `${origin}${MEMBER_FREE_STATUS_PATH}`) throw new Error("Invalid member Auto credential.");
  return credential.apiKey;
}
const DEN_ERROR_CODES = ["free_disabled", "free_accounting_unavailable", "managed_models_disabled_for_dpa", "managed_models_policy_unavailable"];
/** Status and code for a refused credential exchange. */
export function memberCredentialFailure(status: number, body: Uint8Array): { status: number; code: string } {
  const mapped = [401, 403, 429, 503].includes(status) ? status : 503;
  let code = mapped === 401 ? "member_free_auth_required" : mapped === 403 ? "member_free_policy_denied" : "member_free_credentials_unavailable";
  try {
    const error: unknown = JSON.parse(new TextDecoder().decode(body));
    if (isRecord(error) && typeof error.error === "string" && DEN_ERROR_CODES.includes(error.error)) code = error.error;
  } catch {}
  return { status: mapped, code };
}
