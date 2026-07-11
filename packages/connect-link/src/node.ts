// Node-only signing/verification for connect-link tokens (compact JWS,
// EdDSA/Ed25519 via node:crypto — no external JWT dependency). den-api signs
// with this module; the Electron main process ships its own dependency-free
// mirror of `verifyConnectLinkToken` (apps/desktop/electron/connect-link.mjs)
// and this implementation is the reference the tests hold it to.

import { Buffer } from "node:buffer"
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import {
  CONNECT_LINK_ALGORITHM,
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_VERSION,
  type ConnectLinkClaims,
  type ConnectLinkVerifyResult,
} from "@openwork/types/connect-link"
import { connectLinkClaimsSchema, findInsecureConnectLinkUrl, findRefusedConnectLinkUrl } from "./index"

const DEFAULT_CLOCK_SKEW_SECONDS = 60

export type ConnectLinkKeyPair = {
  publicKeyPem: string
  privateKeyPem: string
}

export function generateConnectLinkKeyPair(): ConnectLinkKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    return Buffer.from(value, "base64url").toString("utf8")
  } catch {
    return null
  }
}

export type SignConnectLinkTokenInput = {
  claims: ConnectLinkClaims
  privateKeyPem: string
  kid: string
  /** Permit non-https den/logo URLs (local development and evals only). */
  allowInsecureUrls?: boolean
}

export function signConnectLinkToken(input: SignConnectLinkTokenInput): string {
  const claims = connectLinkClaimsSchema.parse(input.claims)
  if (!input.allowInsecureUrls) {
    const insecure = findInsecureConnectLinkUrl(claims)
    if (insecure) {
      throw new Error(`connect-link claims contain a non-https URL: ${insecure}`)
    }
  }
  const header = { alg: CONNECT_LINK_ALGORITHM, typ: "JWT", kid: input.kid }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`
  // new Uint8Array(...) keeps the calls assignable across the @types/node
  // versions in this workspace (Buffer's backing store is typed as
  // ArrayBufferLike on older lib combinations).
  const signature = sign(null, new Uint8Array(Buffer.from(signingInput, "utf8")), createPrivateKey(input.privateKeyPem))
  return `${signingInput}.${signature.toString("base64url")}`
}

export type VerifyConnectLinkTokenInput = {
  token: string
  /** kid → SPKI PEM public key. Only keys in this map are trusted. */
  publicKeys: Record<string, string>
  nowEpochSeconds?: number
  clockSkewSeconds?: number
  /** Accept http URLs when every insecure target is loopback (dev only). */
  allowInsecureLoopback?: boolean
}

export function verifyConnectLinkToken(input: VerifyConnectLinkTokenInput): ConnectLinkVerifyResult {
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000)
  const skew = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS

  const parts = input.token.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, code: "invalid_token", message: "Token is not a three-part compact JWS." }
  }
  const [headerPart, payloadPart, signaturePart] = parts

  const headerJson = base64UrlDecode(headerPart)
  if (headerJson === null) {
    return { ok: false, code: "invalid_token", message: "Token header is not valid base64url." }
  }
  let header: unknown
  try {
    header = JSON.parse(headerJson)
  } catch {
    return { ok: false, code: "invalid_token", message: "Token header is not valid JSON." }
  }
  if (typeof header !== "object" || header === null) {
    return { ok: false, code: "invalid_token", message: "Token header is not an object." }
  }
  const headerRecord = header as Record<string, unknown>
  if (headerRecord.alg !== CONNECT_LINK_ALGORITHM) {
    return { ok: false, code: "invalid_token", message: `Token alg must be ${CONNECT_LINK_ALGORITHM}.` }
  }
  if ("crit" in headerRecord) {
    return { ok: false, code: "invalid_token", message: "Token crit header is not supported." }
  }
  if (headerRecord.typ !== undefined && headerRecord.typ !== "JWT") {
    return { ok: false, code: "invalid_token", message: "Token typ must be JWT when present." }
  }
  const kid = headerRecord.kid
  if (typeof kid !== "string" || kid.length === 0) {
    return { ok: false, code: "invalid_token", message: "Token kid header is required." }
  }

  const publicKeyPem = input.publicKeys[kid]
  if (!publicKeyPem) {
    return { ok: false, code: "unknown_kid", message: `No trusted key for kid ${kid}.` }
  }

  if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) {
    return { ok: false, code: "invalid_token", message: "Token signature is not valid base64url." }
  }
  const signingInput = new Uint8Array(Buffer.from(`${headerPart}.${payloadPart}`, "utf8"))
  const signature = new Uint8Array(Buffer.from(signaturePart, "base64url"))
  let signatureValid = false
  try {
    signatureValid = verify(null, signingInput, createPublicKey(publicKeyPem), signature)
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return { ok: false, code: "bad_signature", message: "Token signature does not verify." }
  }

  const payloadJson = base64UrlDecode(payloadPart)
  if (payloadJson === null) {
    return { ok: false, code: "invalid_token", message: "Token payload is not valid base64url." }
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return { ok: false, code: "invalid_token", message: "Token payload is not valid JSON." }
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, code: "invalid_token", message: "Token payload is not an object." }
  }
  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.aud !== CONNECT_LINK_AUDIENCE) {
    return { ok: false, code: "wrong_audience", message: "Token audience is not the desktop connect audience." }
  }
  if (payloadRecord.v !== CONNECT_LINK_VERSION) {
    return { ok: false, code: "wrong_version", message: "Token payload version is not supported." }
  }

  const parsed = connectLinkClaimsSchema.safeParse(payload)
  if (!parsed.success) {
    return { ok: false, code: "malformed_claims", message: "Token claims failed validation." }
  }
  const claims = parsed.data

  if (claims.iat > now + skew) {
    return { ok: false, code: "not_yet_valid", message: "Token is not valid yet." }
  }
  if (claims.exp <= now - skew) {
    return { ok: false, code: "expired", message: "Token has expired." }
  }

  const refusedUrl = findRefusedConnectLinkUrl(claims, input.allowInsecureLoopback === true)
  if (refusedUrl) {
    return { ok: false, code: "insecure_url", message: `Token target is not https: ${refusedUrl}` }
  }

  return { ok: true, claims, kid }
}
