import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConnectLinkReplayGuard,
  desktopBootstrapFromConnectClaims,
  extractConnectExchange,
  extractConnectLinkToken,
  resolveConnectExchangeUrl,
  verifyConnectLinkToken,
  verifyConnectLinkUrl,
} from "./connect-link.mjs";

const NOW = 1_783_000_000;
const KID = "owc-test";
const { publicKey: publicKeyPem, privateKey: privateKeyPem } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicKeys = { [KID]: publicKeyPem };

function claims(overrides = {}) {
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
  const signature = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${signature.toString("base64url")}`;
}

function verifyAt(token, nowEpochSeconds = NOW, extra = {}) {
  return verifyConnectLinkToken({ token, publicKeys, nowEpochSeconds, ...extra });
}

/** @param {import("@openwork/types/connect-link").ConnectLinkVerifyResult} result */
function failureOf(result) {
  assert.equal(result.ok, false);
  if (result.ok !== false) throw new Error("expected a failure result");
  return result;
}

test("extracts only dedicated desktop connect links", () => {
  assert.equal(extractConnectLinkToken("openwork://connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork-dev://connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork:///connect?token=a.b.c"), "a.b.c");
  assert.equal(extractConnectLinkToken("openwork://den-auth?grant=x"), null);
  assert.equal(extractConnectLinkToken("https://connect?token=a.b.c"), null);
});

test("verifies an exact signed organization target end to end", () => {
  const expected = claims();
  const token = mint(expected);
  const result = verifyConnectLinkUrl(
    `openwork://connect?token=${encodeURIComponent(token)}`,
    { publicKeys, nowEpochSeconds: NOW },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, expected);
  assert.equal(result.kid, KID);
  assert.equal(result.transport, "signed");
});

test("resolves a keyless exchange through the exact HTTPS Den endpoint", async () => {
  const code = "abcdefghijklmnopqrstuvwxyz123456";
  const apiBaseUrl = "https://api.openwork.acme.example.com/api/den";
  const expected = claims({
    iss: apiBaseUrl,
    brand: {
      appName: "Acme Work",
      logoUrl: "https://assets.acme.example.com/wordmark.svg",
      iconUrl: "https://assets.acme.example.com/icon.png",
    },
    den: {
      baseUrl: "https://openwork.acme.example.com",
      apiBaseUrl,
    },
  });
  const rawUrl = `openwork://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
  assert.deepEqual(extractConnectExchange(rawUrl), { code, apiBaseUrl });

  const calls = [];
  const result = await resolveConnectExchangeUrl(rawUrl, {
    mode: "preview",
    nowEpochSeconds: NOW,
    fetcher: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ claims: expected }));
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected exchange success");
  assert.equal(result.transport, "exchange");
  assert.equal(result.kid, null);
  assert.deepEqual(result.claims, expected);
  assert.equal(calls[0].url, `${apiBaseUrl}/v1/install-connect/preview`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { code });
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(desktopBootstrapFromConnectClaims(result.claims), {
    baseUrl: "https://openwork.acme.example.com",
    apiBaseUrl,
    requireSignin: true,
    brandAppName: "Acme Work",
    brandLogoUrl: "https://assets.acme.example.com/wordmark.svg",
    brandIconUrl: "https://assets.acme.example.com/icon.png",
  });
});

test("fails closed for ambiguous, insecure, mismatched, expired, and replayed exchanges", async () => {
  const code = "abcdefghijklmnopqrstuvwxyz123456";
  const apiBaseUrl = "https://api.openwork.acme.example.com";
  const rawUrl = `openwork://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
  assert.equal(extractConnectExchange(`${rawUrl}&token=a.b.c`), null);

  const insecure = `openwork://connect?code=${code}&apiBaseUrl=${encodeURIComponent("http://den.example.com")}`;
  assert.equal(failureOf(await resolveConnectExchangeUrl(insecure, {
    mode: "preview",
    fetcher: () => Promise.reject(new Error("must not fetch")),
  })).code, "insecure_url");

  const mismatched = await resolveConnectExchangeUrl(rawUrl, {
    mode: "preview",
    nowEpochSeconds: NOW,
    fetcher: () => Promise.resolve(Response.json({ claims: claims({
      iss: "https://other.example.com",
      den: {
        baseUrl: "https://openwork.acme.example.com",
        apiBaseUrl: "https://other.example.com",
      },
    }) })),
  });
  assert.equal(failureOf(mismatched).code, "malformed_claims");

  for (const failureCase of [
    { status: 409, expectedCode: "replayed" },
    { status: 410, expectedCode: "expired" },
    { status: 404, expectedCode: "invalid_token" },
  ]) {
    const result = await resolveConnectExchangeUrl(rawUrl, {
      mode: "exchange",
      fetcher: () => Promise.resolve(Response.json({}, { status: failureCase.status })),
    });
    assert.equal(failureOf(result).code, failureCase.expectedCode);
  }

  const unavailable = await resolveConnectExchangeUrl(rawUrl, {
    mode: "preview",
    fetcher: () => Promise.reject(new Error("offline")),
  });
  assert.equal(failureOf(unavailable).code, "unavailable");
});

test("rejects tampering, algorithm confusion, and unknown keys", () => {
  const token = mint(claims());
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify(claims({
    den: { baseUrl: "https://evil.example.com" },
  }))).toString("base64url");
  assert.equal(failureOf(verifyAt(`${header}.${forged}.${signature}`)).code, "bad_signature");

  for (const invalidHeader of [
    { alg: "none", kid: KID },
    { alg: "HS256", kid: KID },
    { alg: "EdDSA", kid: KID, crit: ["exp"] },
  ]) {
    assert.equal(verifyAt(mint(claims(), invalidHeader)).ok, false);
  }
  assert.equal(failureOf(verifyAt(mint(claims(), { alg: "EdDSA", kid: "other" }))).code, "unknown_kid");
});

test("enforces time and HTTPS policies", () => {
  const token = mint(claims());
  assert.equal(verifyAt(token, NOW + 72 * 3600 + 30).ok, true);
  assert.equal(failureOf(verifyAt(token, NOW + 72 * 3600 + 61)).code, "expired");
  assert.equal(failureOf(verifyAt(token, NOW - 61)).code, "not_yet_valid");

  const intranet = mint(claims({ den: { baseUrl: "http://intranet.example.com" } }));
  assert.equal(failureOf(verifyAt(intranet, NOW, { allowInsecureLoopback: true })).code, "insecure_url");
  const loopback = mint(claims({ den: { baseUrl: "http://127.0.0.1:8790" } }));
  assert.equal(verifyAt(loopback).ok, false);
  assert.equal(verifyAt(loopback, NOW, { allowInsecureLoopback: true }).ok, true);
});

test("replay guard is persistent, atomic, and bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "connect-link-test-"));
  const filePath = path.join(dir, "seen.json");
  const guard = createConnectLinkReplayGuard({ filePath });
  assert.equal(await guard.remember("jti-1"), true);
  assert.equal(await guard.remember("jti-1"), false);

  const reloaded = createConnectLinkReplayGuard({ filePath });
  assert.equal(await reloaded.has("jti-1"), true);
  const concurrent = await Promise.all([
    reloaded.remember("jti-concurrent"),
    reloaded.remember("jti-concurrent"),
  ]);
  assert.deepEqual(concurrent.sort(), [false, true]);

  for (let index = 0; index < 520; index += 1) {
    await reloaded.remember(`jti-fill-${index}`);
  }
  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.ok(persisted.length <= 512);
});
