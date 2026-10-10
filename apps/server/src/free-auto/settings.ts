import { DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID } from "@openwork/free-auto";

export const ANONYMOUS_INFERENCE_PROVIDER_ID = DESKTOP_FREE_PROVIDER_ID;
export const ANONYMOUS_INFERENCE_MODEL_ID = DESKTOP_FREE_MODEL_ID;
export const ANONYMOUS_INFERENCE_PROVIDER_NAME = "OpenWork Models (Free)";
export const LOCAL_ROUTE_PREFIX = "/anonymous-inference/v1";
// Images make requests large; the Gateway accepts up to 32 MiB.
export const REQUEST_BODY_LIMIT = 24 * 1024 * 1024;
export const ERROR_BODY_LIMIT = 64 * 1024;
export const SESSION_TIMEOUT_MS = 10_000;
export const REQUEST_LIFETIME_MS = 5 * 60_000;
export const MEMBER_CREDENTIAL_CACHE_MS = 5 * 60_000;
export const STATUS_CACHE_MS = 10_000;
export const FAILURE_CACHE_MS = 30_000;
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
  /** Loopback Den is allowed only for developer and test runs. */
  allowLocalDen: boolean;
  /** An environment switch can turn free Auto off for this device. */
  disabledByEnvironment: boolean;
};
export function readRelaySettings(environment: NodeJS.ProcessEnv = process.env): RelaySettings {
  return {
    origin: resolveAnonymousInferenceOrigin(environment),
    allowLocalDen: environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test",
    disabledByEnvironment: [environment.OPENWORK_DISABLE_FREE_INFERENCE, environment.OPENWORK_DISABLE_HOSTED_MODELS, environment.VITE_DISABLE_OPENWORK_MODELS]
      .some((value) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "")),
  };
}
