import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { desktopBootstrapFromConnectClaims, resolveConnectExchangeUrl, verifyConnectLinkToken } from "../electron/connect-link.mjs";
import { sanitizeDesktopBootstrapConfig } from "../electron/nuke.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeys = { test: publicKey.export({ type: "spki", format: "pem" }) };
const now = 1000;
const claims = {
  iss: "https://den.example.test",
  aud: "openwork-desktop-connect",
  iat: now,
  exp: now + 300,
  jti: "test-claim-id",
  v: 1,
  org: { name: "Test organization" },
  den: { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" },
  requireSignin: true,
};
function token(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}
function verify(payload) {
  return verifyConnectLinkToken({ token: token(payload), publicKeys, nowEpochSeconds: now });
}

test("accepts signed unbranded claims and ignores legacy branding entirely", () => {
  for (const payload of [claims, { ...claims, brand: { appName: "Legacy desktop", iconUrl: "http://unused.invalid/icon.png" } }, { ...claims, brand: "obsolete" }]) {
    const result = verify(payload);
    assert.equal(result.ok, true);
    assert.deepEqual(result.claims, { ...claims, whiteLabelEnabled: false, brand: { appName: "OpenWork", logoUrl: null, iconUrl: null } });
    assert.deepEqual(desktopBootstrapFromConnectClaims(result.claims), {
      ...claims.den,
      requireSignin: true,
      whiteLabelEnabled: false,
    });
  }
});

test("explicit backend ON carries custom fields but keeps signature and HTTPS verification", () => {
  const brand = { appName: "Organization Desktop", logoUrl: "https://assets.example.test/logo.png", iconUrl: "https://assets.example.test/icon.png" };
  const payload = { ...claims, whiteLabelEnabled: true, brand };
  const result = verify(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims.brand, brand);
  assert.equal(result.claims.whiteLabelEnabled, true);
  assert.equal(desktopBootstrapFromConnectClaims(result.claims).brandAppName, brand.appName);
  assert.equal(verify({ ...payload, brand: { ...brand, iconUrl: "http://assets.example.test/icon.png" } }).code, "insecure_url");
  assert.equal(verify({ ...payload, brand: { ...brand, logoUrl: "javascript:alert(1)" } }).code, "malformed_claims");
  assert.equal(verify({ ...payload, whiteLabelEnabled: "true" }).code, "malformed_claims");
  const signed = token({ ...payload, whiteLabelEnabled: false }).split(".");
  signed[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(verifyConnectLinkToken({ token: signed.join("."), publicKeys, nowEpochSeconds: now }).code, "bad_signature");
});

test("still rejects wrong audience/version, expiry, malformed claims and insecure targets", () => {
  for (const [change, code] of [
    [{ aud: "other" }, "wrong_audience"],
    [{ v: 2 }, "wrong_version"],
    [{ exp: now - 61 }, "expired"],
    [{ iat: now + 61 }, "not_yet_valid"],
    [{ org: null }, "malformed_claims"],
    [{ requireSignin: "true" }, "malformed_claims"],
    [{ den: { baseUrl: "http://den.example.test" } }, "insecure_url"],
    [{ den: { ...claims.den, apiBaseUrl: "http://api.example.test" } }, "insecure_url"],
  ]) assert.equal(verify({ ...claims, ...change }).code, code);
  const signed = token(claims).split(".");
  signed[1] = Buffer.from(JSON.stringify({ ...claims, requireSignin: false })).toString("base64url");
  assert.equal(verifyConnectLinkToken({ token: signed.join("."), publicKeys, nowEpochSeconds: now }).code, "bad_signature");
});

test("exchange transport accepts new claims without weakening HTTPS or replay handling", async () => {
  const rawUrl = `openwork://connect?code=${"x".repeat(24)}&apiBaseUrl=https%3A%2F%2Fapi.example.test`;
  const exchangeClaims = { ...claims, iss: claims.den.apiBaseUrl };
  const result = await resolveConnectExchangeUrl(rawUrl, {
    mode: "exchange",
    nowEpochSeconds: now,
    fetcher: async (_url, init) => {
      assert.equal(init.redirect, "error");
      return Response.json({ claims: exchangeClaims });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, { ...exchangeClaims, whiteLabelEnabled: false, brand: { appName: "OpenWork", logoUrl: null, iconUrl: null } });
  const mismatchedIssuer = await resolveConnectExchangeUrl(rawUrl, {
    mode: "exchange", nowEpochSeconds: now, fetcher: async () => Response.json({ claims }),
  });
  assert.equal(mismatchedIssuer.code, "malformed_claims");
  const replay = await resolveConnectExchangeUrl(rawUrl, { mode: "exchange", fetcher: async () => new Response(null, { status: 409 }) });
  assert.equal(replay.code, "replayed");
  const insecure = await resolveConnectExchangeUrl(rawUrl.replace("https%3A", "http%3A"), {
    mode: "exchange",
    fetcher: async () => { assert.fail("insecure endpoint must not be fetched"); },
  });
  assert.equal(insecure.code, "insecure_url");
});

test("nuke preserves dormant rollback branding but removes credentials and prepared state", () => {
  const dormant = {
    brandAppName: "Legacy desktop",
    brandLogoUrl: "https://unused.invalid/logo.png",
    brandIconUrl: "https://unused.invalid/icon.png",
  };
  const config = sanitizeDesktopBootstrapConfig({
    ...claims.den,
    ...dormant,
    requireSignin: true,
    handoff: { grant: "one-time-secret" },
    claimLinks: [{ token: "secret" }],
    prepared: { orgId: "old-org" },
  }, "test-time");
  assert.deepEqual(config, { ...claims.den, ...dormant, requireSignin: true, writtenAt: "test-time" });
});
