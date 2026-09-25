/**
 * Minting a guest session costs a proof of work bound to the request's
 * single-use nonce: `rounds` small puzzles, each needing a SHA-256 digest
 * with `bits` leading zero bits. Several small puzzles instead of one large
 * one keep the solve time close to its mean (about 1–3 s on a laptop).
 * Hashing is injected so this module stays runtime-neutral.
 */
export const DESKTOP_FREE_SESSION_POW_BITS = 19;
export const DESKTOP_FREE_SESSION_POW_MAX_BITS = 24;
export const DESKTOP_FREE_SESSION_POW_ROUNDS = 8;
export const DESKTOP_FREE_SESSION_POW_MAX_ROUNDS = 16;
/** Round solutions joined by "."; each solution is short base36. */
export const DESKTOP_FREE_SESSION_POW_PATTERN = /^[A-Za-z0-9_-]{1,32}(?:\.[A-Za-z0-9_-]{1,32}){0,15}$/;

export type Sha256 = (message: string) => Uint8Array;
export type SessionPowParams = { bits: number; rounds: number };

export function desktopFreeSessionPowMessage(input: { machineId: string; nonce: string; round: number; pow: string }): string {
  return `${input.machineId}:${input.nonce.toLowerCase()}:${input.round}:${input.pow}`;
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
/** Parses operator or server-supplied work parameters; anything out of range yields `fallback`. */
export function clampSessionPowParams(input: { bits?: unknown; rounds?: unknown }, fallback: SessionPowParams): SessionPowParams {
  const bits = Number(input.bits ?? fallback.bits);
  const rounds = Number(input.rounds ?? fallback.rounds);
  return {
    bits: Number.isSafeInteger(bits) && bits >= 0 && bits <= DESKTOP_FREE_SESSION_POW_MAX_BITS ? bits : fallback.bits,
    rounds: Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= DESKTOP_FREE_SESSION_POW_MAX_ROUNDS ? rounds : fallback.rounds,
  };
}
export function solveSessionPowWith(sha256: Sha256, input: { machineId: string; nonce: string } & SessionPowParams): string {
  return Array.from({ length: input.rounds }, (_, round) => {
    for (let counter = 0; ; counter++) {
      const pow = counter.toString(36);
      if (leadingZeroBits(sha256(desktopFreeSessionPowMessage({ machineId: input.machineId, nonce: input.nonce, round, pow }))) >= input.bits) return pow;
    }
  }).join(".");
}
export function verifySessionPowWith(sha256: Sha256, input: { machineId: string; nonce: string; pow: string | undefined } & SessionPowParams): boolean {
  if (input.bits === 0) return true;
  if (!input.pow || !DESKTOP_FREE_SESSION_POW_PATTERN.test(input.pow)) return false;
  const solutions = input.pow.split(".");
  if (solutions.length !== input.rounds) return false;
  return solutions.every((pow, round) =>
    leadingZeroBits(sha256(desktopFreeSessionPowMessage({ machineId: input.machineId, nonce: input.nonce, round, pow }))) >= input.bits);
}
