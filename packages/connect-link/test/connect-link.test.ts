import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createPrivateKey, sign } from "node:crypto"
import {
  buildConnectDeepLink,
  buildConnectExchangeDeepLink,
  CONNECT_LINK_AUDIENCE,
  type ConnectLinkClaims,
} from "../src/index"
import {
  generateConnectLinkKeyPair,
  signConnectLinkToken,
  verifyConnectLinkToken,
} from "../src/node"

const NOW = 1_783_000_000
const KID = "owc-test"
const { publicKeyPem, privateKeyPem } = generateConnectLinkKeyPair()
const publicKeys = { [KID]: publicKeyPem }

function claims(overrides: Partial<ConnectLinkClaims> = {}): ConnectLinkClaims {
  return {
    iss: "https://api.openwork.acme.example.com",
    aud: CONNECT_LINK_AUDIENCE,
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
  }
}

function mintRaw(header: object, payload: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = sign(null, Buffer.from(signingInput, "utf8"), createPrivateKey(privateKeyPem))
  return `${signingInput}.${signature.toString("base64url")}`
}

function verifyAt(token: string, nowEpochSeconds = NOW) {
  return verifyConnectLinkToken({ token, publicKeys, nowEpochSeconds })
}

describe("signed desktop connect links", () => {
  test("round-trips exact organization configuration", () => {
    const expected = claims()
    const token = signConnectLinkToken({ claims: expected, privateKeyPem, kid: KID })
    const result = verifyAt(token)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected valid token")
    expect(result.claims).toEqual(expected)
    expect(result.kid).toBe(KID)
    expect(result.transport).toBe("signed")
  })

  test("rejects tampered payloads", () => {
    const token = signConnectLinkToken({ claims: claims(), privateKeyPem, kid: KID })
    const [header, , signature] = token.split(".")
    const forged = Buffer.from(JSON.stringify(claims({
      den: { baseUrl: "https://evil.example.com" },
    }))).toString("base64url")
    const result = verifyAt(`${header}.${forged}.${signature}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("bad_signature")
  })

  test("rejects algorithm confusion, critical headers, and unknown keys", () => {
    const tokens = [
      mintRaw({ alg: "none", kid: KID }, claims()),
      mintRaw({ alg: "HS256", typ: "JWT", kid: KID }, claims()),
      mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID, crit: ["exp"] }, claims()),
      mintRaw({ alg: "EdDSA", typ: "JWT", kid: "other" }, claims()),
    ]
    for (const token of tokens) {
      expect(verifyAt(token).ok).toBe(false)
    }
  })

  test("enforces expiry and issued-at with clock skew", () => {
    const token = signConnectLinkToken({ claims: claims(), privateKeyPem, kid: KID })
    expect(verifyAt(token, NOW + 72 * 3600 + 30).ok).toBe(true)
    const expired = verifyAt(token, NOW + 72 * 3600 + 61)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.code).toBe("expired")
    const future = verifyAt(token, NOW - 61)
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.code).toBe("not_yet_valid")
  })

  test("refuses non-HTTPS organization servers except explicit dev loopback", () => {
    const insecure = claims({ den: { baseUrl: "http://intranet.example.com" } })
    expect(() => signConnectLinkToken({ claims: insecure, privateKeyPem, kid: KID })).toThrow(/non-https/)

    const loopback = claims({ den: { baseUrl: "http://127.0.0.1:8790" } })
    const token = signConnectLinkToken({
      claims: loopback,
      privateKeyPem,
      kid: KID,
      allowInsecureUrls: true,
    })
    expect(verifyAt(token).ok).toBe(false)
    expect(verifyConnectLinkToken({
      token,
      publicKeys,
      nowEpochSeconds: NOW,
      allowInsecureLoopback: true,
    }).ok).toBe(true)
  })

  test("builds only the dedicated connect route", () => {
    expect(buildConnectDeepLink("abc.def.ghi")).toBe("openwork://connect?token=abc.def.ghi")
    expect(buildConnectExchangeDeepLink("abcdefghijklmnopqrstuvwxyz123456", "https://den.example.com/api/den"))
      .toBe("openwork://connect?code=abcdefghijklmnopqrstuvwxyz123456&apiBaseUrl=https%3A%2F%2Fden.example.com%2Fapi%2Fden")
  })
})
