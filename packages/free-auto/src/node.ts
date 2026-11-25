import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DESKTOP_FREE_RELEASE_TAG_PATTERN, desktopFreeReleaseTagMessage, WORKBOT_FREE_GRANT_SECRET_MIN_LENGTH, WORKBOT_FREE_GRANT_TTL_MS, type DesktopFreeProofClaims, type DesktopFreeProofRequest, type WorkbotFreeGrantClaims } from "./protocol.js";
import { desktopFreeSessionPowMessage, leadingZeroBits, solveSessionPowWith, verifySessionPowWith, type SessionPowParams } from "./pow.js";

/** SHA-256 hex, as used for proof body and authorization hashes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sha256Bytes(message: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(message).digest());
}

/**
 * Each stable desktop release carries HMAC(master key, version), derived in CI.
 * The gateway derives the same secret from the version a proof claims, so a
 * secret lifted from one release cannot be presented as another.
 */
export const RELEASE_MASTER_KEY_MIN_LENGTH = 32;
export function deriveReleaseSecret(masterKey: string, version: string): Uint8Array {
  const key = masterKey.trim();
  if (key.length < RELEASE_MASTER_KEY_MIN_LENGTH) throw new Error(`The release master key must be at least ${RELEASE_MASTER_KEY_MIN_LENGTH} characters.`);
  if (!version) throw new Error("A release version is required.");
  return Uint8Array.from(createHmac("sha256", key).update(version).digest());
}
/**
 * A short, non-secret label for a master key. The desktop build prints it and the gateway logs it at startup, so a
 * deploy can confirm both sides hold the same key without either one revealing it.
 */
export function releaseKeyFingerprint(masterKey: string): string {
  return createHmac("sha256", masterKey.trim()).update("openwork-free-release-key-fingerprint").digest("hex").slice(0, 12);
}
type ReleaseTagInput = Omit<Extract<DesktopFreeProofClaims, { version: 3 }>, "version" | "releaseTag"> & DesktopFreeProofRequest;
export function releaseTag(secret: Uint8Array, input: ReleaseTagInput): string {
  return createHmac("sha256", secret).update(desktopFreeReleaseTagMessage(input)).digest("hex");
}
/** Constant-time: the first candidate secret whose tag matches, else null. */
export function matchReleaseTag<T extends { secret: Uint8Array }>(tag: string, candidates: readonly T[], input: ReleaseTagInput): T | null {
  if (!DESKTOP_FREE_RELEASE_TAG_PATTERN.test(tag)) return null;
  const supplied = Uint8Array.from(Buffer.from(tag, "hex"));
  for (const candidate of candidates) {
    const expected = Uint8Array.from(Buffer.from(releaseTag(candidate.secret, input), "hex"));
    if (timingSafeEqual(supplied, expected)) return candidate;
  }
  return null;
}

export function solveSessionPow(input: { machineId: string; nonce: string } & SessionPowParams): string {
  return solveSessionPowWith(sha256Bytes, input);
}
export function verifySessionPow(input: { machineId: string; nonce: string; pow: string | undefined } & SessionPowParams): boolean {
  return verifySessionPowWith(sha256Bytes, input);
}

/**
 * The same solver on a worker thread so the UI stays responsive. The worker
 * source is built from the very functions the gateway verifies with, so the
 * two cannot drift.
 */
export const SESSION_POW_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
const leadingZeroBits = ${leadingZeroBits.toString()};
const desktopFreeSessionPowMessage = ${desktopFreeSessionPowMessage.toString()};
const sha256 = (message) => createHash("sha256").update(message).digest();
const solve = ${solveSessionPowWith.toString()};
parentPort.postMessage(solve(sha256, workerData));
`;
export type SessionPowJob = { nonce: string; bits: number; rounds: number; promise: Promise<string>; cancel: () => void };
/**
 * Starts solving for `nonce`. With `inWorker` false (or if the worker fails)
 * it solves in process; a cancelled job never falls back.
 */
export function startSessionPow(input: { machineId: string; nonce: string } & SessionPowParams, inWorker = true): SessionPowJob {
  let worker: Worker | null = null;
  let cancelled = false;
  const solved = new Promise<string>((resolve, reject) => {
    if (!inWorker) { setImmediate(() => { try { resolve(solveSessionPow(input)); } catch (error) { reject(error); } }); return; }
    try {
      worker = new Worker(SESSION_POW_WORKER_SOURCE, { eval: true, workerData: { machineId: input.machineId, nonce: input.nonce, bits: input.bits, rounds: input.rounds } });
      worker.once("message", (pow: unknown) => { if (typeof pow === "string") resolve(pow); else reject(new Error("Invalid proof of work.")); });
      worker.once("error", reject);
      worker.once("exit", (code: number) => { if (code !== 0) reject(new Error("Proof of work worker exited.")); });
    } catch (error) { reject(error); }
  });
  const promise = solved.catch((error: unknown) => { if (cancelled) throw error; return solveSessionPow(input); });
  const cancel = () => { cancelled = true; promise.catch(() => undefined); void worker?.terminate(); };
  return { nonce: input.nonce, bits: input.bits, rounds: input.rounds, promise, cancel };
}

const WORKBOT_GRANT_CONTEXT = "openwork-workbot-free-grant:v1:";

export function readWorkbotFreeGrantSecret(environment: Record<string, string | undefined>): string | null {
  const secret = environment.WORKBOT_FREE_GRANT_SECRET?.trim() ?? "";
  if (!secret) return null;
  if (secret.length < WORKBOT_FREE_GRANT_SECRET_MIN_LENGTH) throw new Error(`WORKBOT_FREE_GRANT_SECRET must be at least ${WORKBOT_FREE_GRANT_SECRET_MIN_LENGTH} characters`);
  return secret;
}

function workbotGrantSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(WORKBOT_GRANT_CONTEXT + payload).digest("base64url");
}

export function signWorkbotFreeGrant(secret: string, claims: WorkbotFreeGrantClaims): string {
  const payload = Buffer.from(JSON.stringify([claims.keyId, claims.organizationId, claims.memberId, claims.expiresAt])).toString("base64url");
  return `${payload}.${workbotGrantSignature(secret, payload)}`;
}

export function verifyWorkbotFreeGrant(secret: string, grant: string | null | undefined, expected: Omit<WorkbotFreeGrantClaims, "expiresAt">, now = Date.now()): boolean {
  if (!grant || grant.length > 1024) return false;
  const [payload, signature, extra] = grant.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const supplied = Buffer.from(signature);
  const computed = Buffer.from(workbotGrantSignature(secret, payload));
  if (supplied.length !== computed.length || !timingSafeEqual(Uint8Array.from(supplied), Uint8Array.from(computed))) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(claims) || claims.length !== 4) return false;
  const [keyId, organizationId, memberId, expiresAt] = claims;
  return keyId === expected.keyId && organizationId === expected.organizationId && memberId === expected.memberId
    && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + WORKBOT_FREE_GRANT_TTL_MS;
}
