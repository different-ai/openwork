import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConnectLinkReplayGuard,
  extractConnectLinkToken,
  verifyConnectLinkToken,
  verifyConnectLinkUrl,
} from "./connect-link.mjs";

const NOW = 1_783_000_000;
const KID = "owc-test";
const { publicKey: PUBLIC_KEY_PEM, privateKey: PRIVATE_KEY_PEM } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PUBLIC_KEYS = { [KID]: PUBLIC_KEY_PEM };

function baseClaims(overrides = {}) {
  return {
    iss: "https://api.openwork.acme.example.com",
    aud: "openwork-desktop-connect",
    iat: NOW,
    exp: NOW + 72 * 3600,
    jti: "test-jti-0001",
    v: 1,
    org: { name: "Acme Robotics" },
    brand: { appName: "Acme Work", logoUrl: null, iconUrl: null },
    den: {
      baseUrl: "https://openwork.acme.example.com",
      apiBaseUrl: "https://api.openwork.acme.example.com",
    },
    requireSignin: true,
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [header]
 */
function mint(payload, header = { alg: "EdDSA", typ: "JWT", kid: KID }) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), createPrivateKey(PRIVATE_KEY_PEM));
  return `${signingInput}.${signature.toString("base64url")}`;
}

function verifyAt(token, nowEpochSeconds = NOW, extra = {}) {
  return verifyConnectLinkToken({ token, publicKeys: PUBLIC_KEYS, nowEpochSeconds, ...extra });
}

/**
 * Asserts the failure arm and returns it (non-strict checkJs does not narrow
 * through bare assert calls).
 * @param {import("@openwork/types/connect-link").ConnectLinkVerifyResult} result
 */
function failureOf(result) {
  assert.equal(result.ok, false);
  if (result.ok !== false) throw new Error("expected a failure result");
  return result;
}

test("extractConnectLinkToken accepts connect links and rejects everything else", () => {
  assert.equal(extractConnectLinkToken("openwork://connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork-dev://connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork:///connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork://den-auth?grant=x"), null);
  assert.equal(extractConnectLinkToken("https://connect?token=a.b.c"), null);
  assert.equal(extractConnectLinkToken("openwork://connect"), null);
  assert.equal(extractConnectLinkToken("not a url"), null);
});

test("verifies a valid token end to end", () => {
  const claims = baseClaims();
  const result = verifyAt(mint(claims));
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, claims);
  assert.equal(result.kid, KID);
});

test("verifyConnectLinkUrl composes extraction and verification", () => {
  const url = `openwork://connect?token=${encodeURIComponent(mint(baseClaims()))}`;
  const result = verifyConnectLinkUrl(url, { publicKeys: PUBLIC_KEYS, nowEpochSeconds: NOW });
  assert.equal(result.ok, true);
  const junk = verifyConnectLinkUrl("openwork://connect?token=junk", { publicKeys: PUBLIC_KEYS, nowEpochSeconds: NOW });
  assert.equal(junk.ok, false);
  assert.equal(junk.code, "invalid_token");
});

test("rejects tampered payloads with bad_signature", () => {
  const token = mint(baseClaims());
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify(baseClaims({ den: { baseUrl: "https://evil.example.com" } })),
    "utf8",
  ).toString("base64url");
  const result = verifyAt(`${header}.${forged}.${signature}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad_signature");
});

test("rejects algorithm confusion, crit headers, and missing kid", () => {
  for (const header of [
    { alg: "none", kid: KID },
    { alg: "HS256", typ: "JWT", kid: KID },
    { alg: "EdDSA", typ: "JWT", kid: KID, crit: ["exp"] },
    { alg: "EdDSA", typ: "JWT" },
  ]) {
    const result = verifyAt(mint(baseClaims(), header));
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_token");
  }
});

test("rejects unknown kid", () => {
  const result = verifyAt(mint(baseClaims(), { alg: "EdDSA", typ: "JWT", kid: "owc-unknown" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_kid");
});

test("enforces expiry and issued-at with clock skew", () => {
  const token = mint(baseClaims());
  const expired = verifyAt(token, NOW + 72 * 3600 + 61);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "expired");
  assert.equal(verifyAt(token, NOW + 72 * 3600 + 30).ok, true);
  const future = verifyAt(token, NOW - 61);
  assert.equal(future.ok, false);
  assert.equal(future.code, "not_yet_valid");
});

test("rejects wrong audience, wrong version, malformed claims", () => {
  assert.equal(failureOf(verifyAt(mint({ ...baseClaims(), aud: "other" }))).code, "wrong_audience");
  assert.equal(failureOf(verifyAt(mint({ ...baseClaims(), v: 2 }))).code, "wrong_version");
  const { org: _org, ...withoutOrg } = baseClaims();
  assert.equal(failureOf(verifyAt(mint(withoutOrg))).code, "malformed_claims");
  const { brand: _brand, ...withoutBrand } = baseClaims();
  assert.equal(failureOf(verifyAt(mint(withoutBrand))).code, "malformed_claims");
  assert.equal(failureOf(verifyAt(mint(baseClaims({ jti: "short" })))).code, "malformed_claims");
});

test("rejects insecure URLs except opted-in loopback", () => {
  const intranet = mint(baseClaims({ den: { baseUrl: "http://intranet.acme.example.com" } }));
  const rejected = verifyAt(intranet);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "insecure_url");
  const stillRejected = verifyAt(intranet, NOW, { allowInsecureLoopback: true });
  assert.equal(stillRejected.ok, false);

  const loopback = mint(baseClaims({ den: { baseUrl: "http://127.0.0.1:8788" } }));
  assert.equal(verifyAt(loopback).ok, false);
  assert.equal(verifyAt(loopback, NOW, { allowInsecureLoopback: true }).ok, true);

  const mixedTargets = mint(baseClaims({
    den: {
      baseUrl: "http://127.0.0.1:8788",
      apiBaseUrl: "http://intranet.acme.example.com/api",
    },
  }));
  const mixedRejected = verifyAt(mixedTargets, NOW, { allowInsecureLoopback: true });
  assert.equal(mixedRejected.ok, false);
  assert.equal(mixedRejected.code, "insecure_url");

  const insecureIcon = mint(baseClaims({
    brand: {
      appName: "Acme Work",
      logoUrl: null,
      iconUrl: "http://cdn.acme.example.com/icon.png",
    },
  }));
  assert.equal(failureOf(verifyAt(insecureIcon)).code, "insecure_url");
});

test("replay guard remembers ids across instances and bounds the file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "connect-link-test-"));
  const filePath = path.join(dir, "seen.json");
  const guard = createConnectLinkReplayGuard({ filePath });
  assert.equal(await guard.has("jti-1"), false);
  assert.equal(await guard.remember("jti-1"), true);
  assert.equal(await guard.has("jti-1"), true);
  assert.equal(await guard.remember("jti-1"), false);

  const reloaded = createConnectLinkReplayGuard({ filePath });
  assert.equal(await reloaded.has("jti-1"), true);

  const concurrent = await Promise.all([
    reloaded.remember("jti-concurrent"),
    reloaded.remember("jti-concurrent"),
  ]);
  assert.deepEqual(concurrent.sort(), [false, true]);

  for (let i = 0; i < 600; i += 1) {
    await reloaded.remember(`jti-fill-${i}`);
  }
  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.ok(persisted.length <= 512);
  assert.equal(await reloaded.has("jti-1"), false);
});
