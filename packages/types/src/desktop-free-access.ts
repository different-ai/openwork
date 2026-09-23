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
/** Minting a guest session costs a small proof-of-work bound to the request's single-use nonce. */
/** ~3 s of hashing on a laptop; the desktop solves it in the background while the app loads. */
export const DESKTOP_FREE_SESSION_POW_BITS = 23;
export const DESKTOP_FREE_SESSION_POW_MAX_BITS = 26;
export const DESKTOP_FREE_SESSION_POW_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function desktopFreeSessionPowMessage(input: { machineId: string; nonce: string; pow: string }): string {
  return `${input.machineId}:${input.nonce.toLowerCase()}:${input.pow}`;
}
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
export const DESKTOP_FREE_PROOF_CLOCK_SKEW_MS = 60_000;

/** SHA-256 hex of the OS machine identifier, salted per product; stable across reinstalls. */
export const DESKTOP_FREE_MACHINE_ID_PATTERN = /^[a-f0-9]{64}$/;

type DesktopFreeProofBase = {
  publicKey: string;
  machineId: string;
  appVersion: string;
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  timestamp: number;
  nonce: string;
};
/**
 * v3 adds `releaseTag`: an HMAC over the request by a secret that each stable
 * desktop release derives at build time, so the gateway can tell which
 * release signed the request and refuse releases outside its support window.
 */
export type DesktopFreeProofClaims = (DesktopFreeProofBase & { version: 2 }) | (DesktopFreeProofBase & { version: 3; releaseTag: string });
export type DesktopFreeProof = DesktopFreeProofClaims & { signature: string };
export const DESKTOP_FREE_RELEASE_TAG_PATTERN = /^[a-f0-9]{64}$/;

type DesktopFreeProofRequest = { method: string; path: string; bodyHash: string; authorizationHash: string };
function desktopFreeProofFields(input: DesktopFreeProofBase & DesktopFreeProofRequest): unknown[] {
  return [
    input.method.toUpperCase(), input.path, input.bodyHash,
    input.authorizationHash, input.publicKey, input.machineId, input.appVersion, input.platform,
    input.arch, input.timestamp, input.nonce,
  ];
}
/** What the release secret tags: the same request fields, without the tag itself. */
export function desktopFreeReleaseTagMessage(input: DesktopFreeProofBase & DesktopFreeProofRequest): string {
  return JSON.stringify([3, ...desktopFreeProofFields(input)]);
}
/** What the device key signs. A v3 signature also covers the release tag. */
export function desktopFreeProofMessage(input: DesktopFreeProofClaims & DesktopFreeProofRequest): string {
  return input.version === 3
    ? JSON.stringify([3, ...desktopFreeProofFields(input), input.releaseTag])
    : JSON.stringify([2, ...desktopFreeProofFields(input)]);
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
  defaultPinned?: boolean;
};
export type DesktopFreeVersionError = {
  code: "desktop_update_required" | "desktop_version_unavailable";
  currentVersion: string;
  minimumVersion: string | null;
  message: string;
};
export type DesktopFreeSession = { token: string; expiresAt: number; model: typeof DESKTOP_FREE_MODEL_ID };
