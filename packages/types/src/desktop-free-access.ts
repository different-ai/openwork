import type { ManagedModelRecommendation } from "./den/inference.js";

export const DESKTOP_FREE_PROOF_HEADER = "x-openwork-desktop-proof";
export const DESKTOP_FREE_TOKEN_HEADER = "x-openwork-desktop-token";
export const DESKTOP_FREE_PROVIDER_ID = "openwork-free";
export const DESKTOP_FREE_MODEL_ID = "openai/gpt-5.6-luna";
export const DESKTOP_FREE_SESSION_PATH = "/api/anonymous/session";
export const DESKTOP_FREE_STATUS_PATH = "/api/anonymous/status";
export const DESKTOP_FREE_MODELS_PATH = "/api/anonymous/v1/models";
export const DESKTOP_FREE_CHAT_PATH = "/api/anonymous/v1/chat/completions";
export const DESKTOP_FREE_PROOF_MAX_BYTES = 2048;
export const DESKTOP_FREE_PROOF_CLOCK_SKEW_MS = 60_000;

// Native-owned, self-reported metadata. Key possession deters copied bearers;
// this is not attestation of an official binary or an unresettable installation.
export type DesktopFreeProofClaims = {
  version: 1;
  publicKey: string; // Ed25519 SPKI DER, canonical base64
  appVersion: string;
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  timestamp: number; // Unix milliseconds
  nonce: string; // UUID, unique per signed request
};

export type DesktopFreeProof = DesktopFreeProofClaims & {
  signature: string; // Ed25519 signature, base64url; whole header is base64url JSON
};

export function desktopFreeProofMessage(input: DesktopFreeProofClaims & {
  method: string;
  path: string; // URL pathname plus search, without origin
  bodyHash: string; // SHA-256 lowercase hex of RAW body bytes (empty for GET)
  authorizationHash: string; // SHA-256 of the actual header, including Bearer, or empty
}): string {
  return JSON.stringify([
    1, input.method.toUpperCase(), input.path, input.bodyHash,
    input.authorizationHash, input.publicKey, input.appVersion, input.platform,
    input.arch, input.timestamp, input.nonce,
  ]);
}

export type DesktopFreeAccessStatus = {
  state: "ready" | "update_required" | "unavailable" | "exhausted";
  code: string | null;
  currentVersion: string;
  minimumVersion: string | null;
  providerID: typeof DESKTOP_FREE_PROVIDER_ID;
  modelID: typeof DESKTOP_FREE_MODEL_ID;
  // Conservative estimates: used includes retained unknown usage; reserved
  // includes active safety holds. Remaining is not a promise a hold will fit.
  allowance: {
    limitUsd: number;
    usedUsd: number;
    reservedUsd: number;
    remainingUsd: number;
    resetsAt: string;
  } | null;
  // Discovery only, not connected models or entitlements. Paid recommendations
  // are read-only upgrade choices until real paid credentials are available.
  catalog?: ManagedModelRecommendation[];
};

export type DesktopFreeVersionError = {
  code: "desktop_update_required" | "desktop_version_unavailable";
  currentVersion: string;
  minimumVersion: string | null;
  message: string;
};

export type DesktopFreeSession = {
  token: string;
  expiresAt: number;
  model: typeof DESKTOP_FREE_MODEL_ID;
};
