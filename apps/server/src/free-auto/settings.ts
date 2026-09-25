import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_POW_BITS, DESKTOP_FREE_SESSION_POW_ROUNDS, clampSessionPowParams, type SessionPowParams,
} from "@openwork/free-auto";

export const ANONYMOUS_INFERENCE_PROVIDER_ID = DESKTOP_FREE_PROVIDER_ID;
export const ANONYMOUS_INFERENCE_MODEL_ID = DESKTOP_FREE_MODEL_ID;
export const ANONYMOUS_INFERENCE_PROVIDER_NAME = "OpenWork Models (Free)";
export const LOCAL_ROUTE_PREFIX = "/anonymous-inference/v1";
export const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
export const ERROR_BODY_LIMIT = 64 * 1024;
export const SESSION_TIMEOUT_MS = 10_000;
export const REQUEST_LIFETIME_MS = 5 * 60_000;
export const MEMBER_CREDENTIAL_CACHE_MS = 5 * 60_000;
export const STATUS_CACHE_MS = 10_000;
export const FAILURE_CACHE_MS = 30_000;
/** How long a guest session refusal (guest Auto switched off, or at capacity) holds before this device solves new work. */
export const GUEST_REFUSAL_MIN_MS = 60_000;
export const GUEST_REFUSAL_DEFAULT_MS = 15 * 60_000;
export const GUEST_REFUSAL_MAX_MS = 60 * 60_000;
export const FAILURE_CACHE_LIMIT = 64;
export const HEADER_TIMEOUT_MS = 30_000;
export const REQUEST_BODY_TIMEOUT_MS = 15_000;

export function resolveAnonymousInferenceOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(environment.OPENWORK_FREE_INFERENCE_ORIGIN?.trim() || "https://inference.openworklabs.com");
  const local = (environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test")
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must be an HTTPS origin (loopback HTTP is development-only).");
  }
  return url.origin;
}

export type RelaySettings = {
  origin: string;
  /** Proof-of-work parameters this build starts with; the gateway may ask for more. */
  pow: SessionPowParams;
  /** How often a signed-out app reports that it is open; 0 disables it. */
  heartbeatMs: number;
  /** Loopback Den is allowed only for developer and test runs. */
  allowLocalDen: boolean;
  /** An environment switch can turn free Auto off for this device. */
  disabledByEnvironment: boolean;
};
export function readRelaySettings(environment: NodeJS.ProcessEnv = process.env): RelaySettings {
  const heartbeatMs = Number(environment.OPENWORK_FREE_HEARTBEAT_MS ?? 60_000);
  return {
    origin: resolveAnonymousInferenceOrigin(environment),
    pow: clampSessionPowParams({ bits: environment.OPENWORK_FREE_SESSION_POW_BITS, rounds: environment.OPENWORK_FREE_SESSION_POW_ROUNDS },
      { bits: DESKTOP_FREE_SESSION_POW_BITS, rounds: DESKTOP_FREE_SESSION_POW_ROUNDS }),
    heartbeatMs: Number.isSafeInteger(heartbeatMs) && heartbeatMs >= 0 ? heartbeatMs : 60_000,
    allowLocalDen: environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test",
    disabledByEnvironment: [environment.OPENWORK_DISABLE_FREE_INFERENCE, environment.OPENWORK_DISABLE_HOSTED_MODELS, environment.VITE_DISABLE_OPENWORK_MODELS]
      .some((value) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "")),
  };
}
