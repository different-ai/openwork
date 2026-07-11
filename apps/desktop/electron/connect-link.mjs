// Verification for connect links (openwork://connect?token=<JWT>) in the
// Electron main process. The renderer only ever hands us the raw deep-link
// URL; every security decision happens on this side of the trust boundary,
// against public keys embedded in the build (connect-link-keys.mjs).
//
// Dependency-free mirror of packages/connect-link/src/node.ts
// (verifyConnectLinkToken) — the package tests hold the two in lockstep via
// the shared claim fixtures. Compact JWS, EdDSA/Ed25519 via node:crypto.

import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CONNECT_LINK_ALGORITHM = "EdDSA";
const CONNECT_LINK_AUDIENCE = "openwork-desktop-connect";
const CONNECT_LINK_VERSION = 1;
const CONNECT_LINK_ROUTE = "connect";
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const REPLAY_GUARD_MAX_ENTRIES = 512;

/**
 * @param {string} value
 * @returns {string | null}
 */
function base64UrlDecode(value) {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isLoopbackUrl(rawUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {import("@openwork/types/connect-link").ConnectLinkClaims} claims
 * @returns {string | null}
 */
function findRefusedClaimUrl(claims, allowInsecureLoopback) {
  const candidates = [
    claims.den.baseUrl,
    claims.den.apiBaseUrl ?? null,
    claims.brand.logoUrl,
    claims.brand.iconUrl,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      return candidate;
    }
    if (parsed.protocol !== "https:" && !(allowInsecureLoopback && isLoopbackUrl(candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Structural claim validation, mirroring connectLinkClaimsSchema in
 * packages/connect-link. Hand-rolled because the Electron main process keeps
 * zero runtime workspace dependencies.
 *
 * @param {unknown} payload
 * @returns {import("@openwork/types/connect-link").ConnectLinkClaims | null}
 */
function normalizeClaims(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const org = record.org;
  const brand = record.brand;
  const den = record.den;
  if (typeof org !== "object" || org === null) return null;
  if (typeof brand !== "object" || brand === null) return null;
  if (typeof den !== "object" || den === null) return null;
  const orgRecord = /** @type {Record<string, unknown>} */ (org);
  const brandRecord = /** @type {Record<string, unknown>} */ (brand);
  const denRecord = /** @type {Record<string, unknown>} */ (den);

  const iss = typeof record.iss === "string" ? record.iss.trim() : "";
  const jti = typeof record.jti === "string" ? record.jti.trim() : "";
  const orgName = typeof orgRecord.name === "string" ? orgRecord.name.trim() : "";
  const brandAppName = typeof brandRecord.appName === "string" ? brandRecord.appName.trim() : "";
  const brandLogoUrl = typeof brandRecord.logoUrl === "string" ? brandRecord.logoUrl.trim() : null;
  const brandIconUrl = typeof brandRecord.iconUrl === "string" ? brandRecord.iconUrl.trim() : null;
  const denBaseUrl = typeof denRecord.baseUrl === "string" ? denRecord.baseUrl.trim() : "";
  const denApiBaseUrlRaw = denRecord.apiBaseUrl;
  const denApiBaseUrl = typeof denApiBaseUrlRaw === "string" ? denApiBaseUrlRaw.trim() : null;

  if (!iss || !isHttpUrl(iss)) return null;
  if (record.aud !== CONNECT_LINK_AUDIENCE) return null;
  if (typeof record.iat !== "number" || !Number.isInteger(record.iat) || record.iat < 0) return null;
  if (typeof record.exp !== "number" || !Number.isInteger(record.exp) || record.exp < 0) return null;
  if (jti.length < 8) return null;
  if (record.v !== CONNECT_LINK_VERSION) return null;
  if (!orgName || orgName.length > 128) return null;
  if (!brandAppName || brandAppName.length > 64) return null;
  if (brandLogoUrl !== null && !isHttpUrl(brandLogoUrl)) return null;
  if (brandIconUrl !== null && !isHttpUrl(brandIconUrl)) return null;
  if (!denBaseUrl || !isHttpUrl(denBaseUrl)) return null;
  if (denApiBaseUrl !== null && !isHttpUrl(denApiBaseUrl)) return null;
  if (typeof record.requireSignin !== "boolean") return null;

  return {
    iss,
    aud: CONNECT_LINK_AUDIENCE,
    iat: record.iat,
    exp: record.exp,
    jti,
    v: CONNECT_LINK_VERSION,
    org: { name: orgName },
    brand: { appName: brandAppName, logoUrl: brandLogoUrl, iconUrl: brandIconUrl },
    den: { baseUrl: denBaseUrl, ...(denApiBaseUrl !== null ? { apiBaseUrl: denApiBaseUrl } : {}) },
    requireSignin: record.requireSignin,
  };
}

/**
 * Extracts the signed token from a connect deep link. Accepts the openwork
 * and openwork-dev schemes and both authority forms (openwork://connect and
 * openwork:///connect).
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function extractConnectLinkToken(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "openwork:" && parsed.protocol !== "openwork-dev:") return null;
  const route = (parsed.hostname || parsed.pathname.replace(/^\/+|\/+$/g, "")).toLowerCase();
  if (route !== CONNECT_LINK_ROUTE) return null;
  const token = parsed.searchParams.get("token")?.trim();
  return token || null;
}

/**
 * @param {{
 *   token: string,
 *   publicKeys: Record<string, string>,
 *   nowEpochSeconds?: number,
 *   clockSkewSeconds?: number,
 *   allowInsecureLoopback?: boolean,
 * }} input
 * @returns {import("@openwork/types/connect-link").ConnectLinkVerifyResult}
 */
export function verifyConnectLinkToken(input) {
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

  const parts = input.token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, code: "invalid_token", message: "Token is not a three-part compact JWS." };
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  const headerJson = base64UrlDecode(headerPart);
  if (headerJson === null) {
    return { ok: false, code: "invalid_token", message: "Token header is not valid base64url." };
  }
  let header;
  try {
    header = JSON.parse(headerJson);
  } catch {
    return { ok: false, code: "invalid_token", message: "Token header is not valid JSON." };
  }
  if (typeof header !== "object" || header === null) {
    return { ok: false, code: "invalid_token", message: "Token header is not an object." };
  }
  if (header.alg !== CONNECT_LINK_ALGORITHM) {
    return { ok: false, code: "invalid_token", message: `Token alg must be ${CONNECT_LINK_ALGORITHM}.` };
  }
  if ("crit" in header) {
    return { ok: false, code: "invalid_token", message: "Token crit header is not supported." };
  }
  if (header.typ !== undefined && header.typ !== "JWT") {
    return { ok: false, code: "invalid_token", message: "Token typ must be JWT when present." };
  }
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    return { ok: false, code: "invalid_token", message: "Token kid header is required." };
  }

  const publicKeyPem = input.publicKeys[kid];
  if (!publicKeyPem) {
    return { ok: false, code: "unknown_kid", message: `No trusted key for kid ${kid}.` };
  }

  if (!BASE64URL_PATTERN.test(signaturePart)) {
    return { ok: false, code: "invalid_token", message: "Token signature is not valid base64url." };
  }
  const signingInput = Buffer.from(`${headerPart}.${payloadPart}`, "utf8");
  const signature = Buffer.from(signaturePart, "base64url");
  let signatureValid = false;
  try {
    signatureValid = verify(null, signingInput, createPublicKey(publicKeyPem), signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, code: "bad_signature", message: "Token signature does not verify." };
  }

  const payloadJson = base64UrlDecode(payloadPart);
  if (payloadJson === null) {
    return { ok: false, code: "invalid_token", message: "Token payload is not valid base64url." };
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, code: "invalid_token", message: "Token payload is not valid JSON." };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, code: "invalid_token", message: "Token payload is not an object." };
  }
  if (payload.aud !== CONNECT_LINK_AUDIENCE) {
    return { ok: false, code: "wrong_audience", message: "Token audience is not the desktop connect audience." };
  }
  if (payload.v !== CONNECT_LINK_VERSION) {
    return { ok: false, code: "wrong_version", message: "Token payload version is not supported." };
  }

  const claims = normalizeClaims(payload);
  if (!claims) {
    return { ok: false, code: "malformed_claims", message: "Token claims failed validation." };
  }

  if (claims.iat > now + skew) {
    return { ok: false, code: "not_yet_valid", message: "Token is not valid yet." };
  }
  if (claims.exp <= now - skew) {
    return { ok: false, code: "expired", message: "Token has expired." };
  }

  const refusedUrl = findRefusedClaimUrl(claims, input.allowInsecureLoopback === true);
  if (refusedUrl) {
    return { ok: false, code: "insecure_url", message: `Token target is not https: ${refusedUrl}` };
  }

  return { ok: true, claims, kid };
}

/**
 * Verifies a raw connect deep-link URL end to end.
 *
 * @param {string} rawUrl
 * @param {{
 *   publicKeys: Record<string, string>,
 *   nowEpochSeconds?: number,
 *   allowInsecureLoopback?: boolean,
 * }} options
 * @returns {import("@openwork/types/connect-link").ConnectLinkVerifyResult}
 */
export function verifyConnectLinkUrl(rawUrl, options) {
  const token = extractConnectLinkToken(rawUrl);
  if (!token) {
    return { ok: false, code: "invalid_token", message: "Not a connect deep link." };
  }
  return verifyConnectLinkToken({
    token,
    publicKeys: options.publicKeys,
    nowEpochSeconds: options.nowEpochSeconds,
    allowInsecureLoopback: options.allowInsecureLoopback,
  });
}

/**
 * Bounded persisted set of accepted token ids: a connect link reconfigures
 * the app at most once, so replaying an emailed link later is refused even
 * inside its validity window.
 *
 * @param {{ filePath: string }} options
 */
export function createConnectLinkReplayGuard(options) {
  /** @type {string[] | null} */
  let cache = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const raw = await readFile(options.filePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  return {
    /** @param {string} jti */
    async has(jti) {
      const entries = await load();
      return entries.includes(jti);
    },
    /**
     * Atomically consumes a token id within this app process. Returns false
     * when it was already consumed. Persistence errors reject so callers can
     * fail closed before mutating bootstrap configuration.
     * @param {string} jti
     * @returns {Promise<boolean>}
     */
    async remember(jti) {
      const operation = writeQueue.then(async () => {
        const entries = await load();
        if (entries.includes(jti)) return false;
        entries.push(jti);
        while (entries.length > REPLAY_GUARD_MAX_ENTRIES) entries.shift();
        await mkdir(path.dirname(options.filePath), { recursive: true });
        await writeFile(options.filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
        return true;
      });
      writeQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
