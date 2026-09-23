import type { ManagedModelRecommendation } from "./den/inference.js";

export const DESKTOP_FREE_PROOF_HEADER = "x-openwork-desktop-proof";
export const DESKTOP_FREE_TOKEN_HEADER = "x-openwork-desktop-token";
export const DESKTOP_FREE_PROVIDER_ID = "openwork-free";
export const DESKTOP_FREE_MODEL_ID = "openai/gpt-5.6-luna";
export const DESKTOP_FREE_SESSION_PATH = "/api/anonymous/session";
export const DESKTOP_FREE_STATUS_PATH = "/api/anonymous/status";
export const DESKTOP_FREE_MODELS_PATH = "/api/anonymous/v1/models";
export const DESKTOP_FREE_CHAT_PATH = "/api/anonymous/v1/chat/completions";
// Signed-in members use their OpenWork Models key on the regular inference routes.
export const MEMBER_FREE_STATUS_PATH = "/api/v1/auto/status";
export const MEMBER_FREE_MODELS_PATH = "/api/v1/models";
export const MEMBER_FREE_CHAT_PATH = "/api/v1/chat/completions";
export const DESKTOP_FREE_PROOF_MAX_BYTES = 2048;
export const DESKTOP_FREE_PROOF_CLOCK_SKEW_MS = 60_000;

/** SHA-256 hex of the OS machine identifier, salted per product; stable across reinstalls. */
export const DESKTOP_FREE_MACHINE_ID_PATTERN = /^[a-f0-9]{64}$/;

export type DesktopFreeProofClaims = {
  version: 2;
  publicKey: string;
  machineId: string;
  appVersion: string;
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  timestamp: number;
  nonce: string;
};
export type DesktopFreeProof = DesktopFreeProofClaims & { signature: string };

export function desktopFreeProofMessage(input: DesktopFreeProofClaims & {
  method: string; path: string; bodyHash: string; authorizationHash: string;
}): string {
  return JSON.stringify([
    2, input.method.toUpperCase(), input.path, input.bodyHash,
    input.authorizationHash, input.publicKey, input.machineId, input.appVersion, input.platform,
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
  allowance: {
    limitUsd: number; usedUsd: number; reservedUsd: number; remainingUsd: number; resetsAt: string;
  } | null;
  catalog?: ManagedModelRecommendation[];
};
export type DesktopFreeVersionError = {
  code: "desktop_update_required" | "desktop_version_unavailable";
  currentVersion: string;
  minimumVersion: string | null;
  message: string;
};
export type DesktopFreeSession = { token: string; expiresAt: number; model: typeof DESKTOP_FREE_MODEL_ID };
