import type { ManagedModelRecommendation } from "@openwork/types/den/inference";

/**
 * The wire contract for free Auto. The desktop main process signs requests,
 * the desktop relay forwards them, and the Gateway verifies them: every
 * constant and message layout here must be identical on all three sides.
 */
export const DESKTOP_FREE_PROOF_HEADER = "x-openwork-desktop-proof";
export const DESKTOP_FREE_TOKEN_HEADER = "x-openwork-desktop-token";
export const DESKTOP_FREE_PROVIDER_ID = "openwork-free";
export const DESKTOP_FREE_MODEL_ID = "openai/gpt-5.6-luna";

// Signed-out desktop routes.
export const DESKTOP_FREE_SESSION_PATH = "/api/anonymous/session";
export const DESKTOP_FREE_STATUS_PATH = "/api/anonymous/status";
export const DESKTOP_FREE_MODELS_PATH = "/api/anonymous/v1/models";
export const DESKTOP_FREE_CHAT_PATH = "/api/anonymous/v1/chat/completions";
// Signed-in members use their OpenWork Models key on the regular inference routes.
export const MEMBER_FREE_STATUS_PATH = "/api/v1/auto/status";
export const MEMBER_FREE_MODELS_PATH = "/api/v1/models";
export const MEMBER_FREE_CHAT_PATH = "/api/v1/chat/completions";
/** Den route that issues a signed-in member's free Auto credential. */
export const MEMBER_FREE_CREDENTIAL_PATH = "/v1/inference/free/credential";

/** The only method/path pairs a desktop proof may be signed for. */
export const DESKTOP_FREE_SIGNABLE_ROUTES: Readonly<Record<"GET" | "POST", readonly string[]>> = Object.freeze({
  POST: Object.freeze([DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_CHAT_PATH]),
  GET: Object.freeze([DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_STATUS_PATH]),
});
export function isDesktopFreeSignableRoute(method: string, path: string): boolean {
  const routes = method === "GET" || method === "POST" ? DESKTOP_FREE_SIGNABLE_ROUTES[method] : [];
  return routes.includes(path);
}

export const DESKTOP_FREE_PROOF_MAX_BYTES = 2048;
export const DESKTOP_FREE_PROOF_CLOCK_SKEW_MS = 60_000;
export const DESKTOP_FREE_PLATFORMS = ["darwin", "win32", "linux"] as const;
export const DESKTOP_FREE_ARCHES = ["arm64", "x64"] as const;
/** Proof nonces are RFC 4122 UUIDs. */
export const DESKTOP_FREE_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** SHA-256 hex of the OS machine identifier, salted per product; stable across reinstalls. */
export const DESKTOP_FREE_MACHINE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const DESKTOP_FREE_RELEASE_TAG_PATTERN = /^[a-f0-9]{64}$/;

export type DesktopFreePlatform = (typeof DESKTOP_FREE_PLATFORMS)[number];
export type DesktopFreeArch = (typeof DESKTOP_FREE_ARCHES)[number];
type DesktopFreeProofBase = {
  publicKey: string;
  machineId: string;
  appVersion: string;
  platform: DesktopFreePlatform;
  arch: DesktopFreeArch;
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
export type DesktopFreeProofRequest = { method: string; path: string; bodyHash: string; authorizationHash: string };

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
