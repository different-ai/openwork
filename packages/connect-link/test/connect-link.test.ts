import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createPrivateKey, sign } from "node:crypto"
import {
  buildConnectDeepLink,
  CONNECT_LINK_AUDIENCE,
  connectLinkClaimsSchema,
  findInsecureConnectLinkUrl,
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
const PUBLIC_KEYS = { [KID]: publicKeyPem }

function baseClaims(overrides: Partial<ConnectLinkClaims> = {}): ConnectLinkClaims {
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

function mintRaw(header: object, payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = sign(null, Buffer.from(signingInput, "utf8"), createPrivateKey(privateKeyPem))
  return `${signingInput}.${signature.toString("base64url")}`
}

function verifyAt(token: string, nowEpochSeconds = NOW) {
  return verifyConnectLinkToken({ token, publicKeys: PUBLIC_KEYS, nowEpochSeconds })
}

describe("signConnectLinkToken", () => {
  test("round-trips through verify", () => {
    const claims = baseClaims()
    const token = signConnectLinkToken({ claims, privateKeyPem, kid: KID })
    const result = verifyAt(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims).toEqual(claims)
      expect(result.kid).toBe(KID)
    }
  })

  test("refuses non-https targets unless explicitly allowed", () => {
    const claims = baseClaims({ den: { baseUrl: "http://openwork.acme.example.com", apiBaseUrl: null } })
    expect(() => signConnectLinkToken({ claims, privateKeyPem, kid: KID })).toThrow(/non-https/)
    const token = signConnectLinkToken({ claims, privateKeyPem, kid: KID, allowInsecureUrls: true })
    expect(token.split(".")).toHaveLength(3)
  })
})

describe("verifyConnectLinkToken", () => {
  test("rejects garbage tokens", () => {
    for (const token of ["", "abc", "a.b", "a.b.c.d", "!!.__.--"]) {
      const result = verifyAt(token)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("invalid_token")
    }
  })

  test("rejects tampered payloads", () => {
    const token = signConnectLinkToken({ claims: baseClaims(), privateKeyPem, kid: KID })
    const [header, , signature] = token.split(".")
    const forgedPayload = Buffer.from(
      JSON.stringify(baseClaims({ den: { baseUrl: "https://evil.example.com" } })),
      "utf8",
    ).toString("base64url")
    const result = verifyAt(`${header}.${forgedPayload}.${signature}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("bad_signature")
  })

  test("rejects algorithm confusion and crit headers", () => {
    const none = mintRaw({ alg: "none", kid: KID }, baseClaims())
    const hs = mintRaw({ alg: "HS256", typ: "JWT", kid: KID }, baseClaims())
    const crit = mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID, crit: ["exp"] }, baseClaims())
    for (const token of [none, hs, crit]) {
      const result = verifyAt(token)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("invalid_token")
    }
  })

  test("rejects unknown kids", () => {
    const token = mintRaw({ alg: "EdDSA", typ: "JWT", kid: "owc-other" }, baseClaims())
    const result = verifyAt(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("unknown_kid")
  })

  test("rejects missing kid", () => {
    const token = mintRaw({ alg: "EdDSA", typ: "JWT" }, baseClaims())
    const result = verifyAt(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_token")
  })

  test("enforces expiry and issued-at with skew", () => {
    const token = signConnectLinkToken({ claims: baseClaims(), privateKeyPem, kid: KID })
    const expired = verifyAt(token, NOW + 72 * 3600 + 61)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.code).toBe("expired")
    const withinSkew = verifyAt(token, NOW + 72 * 3600 + 30)
    expect(withinSkew.ok).toBe(true)
    const future = verifyAt(token, NOW - 61)
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.code).toBe("not_yet_valid")
  })

  test("rejects wrong audience and wrong version", () => {
    const wrongAud = mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID }, { ...baseClaims(), aud: "other" })
    const audResult = verifyAt(wrongAud)
    expect(audResult.ok).toBe(false)
    if (!audResult.ok) expect(audResult.code).toBe("wrong_audience")
    const wrongVersion = mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID }, { ...baseClaims(), v: 2 })
    const versionResult = verifyAt(wrongVersion)
    expect(versionResult.ok).toBe(false)
    if (!versionResult.ok) expect(versionResult.code).toBe("wrong_version")
  })

  test("rejects structurally invalid claims", () => {
    const { org: _org, ...withoutOrg } = baseClaims()
    const token = mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID }, withoutOrg)
    const result = verifyAt(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("malformed_claims")
    const { brand: _brand, ...withoutBrand } = baseClaims()
    const brandToken = mintRaw({ alg: "EdDSA", typ: "JWT", kid: KID }, withoutBrand)
    const brandResult = verifyAt(brandToken)
    expect(brandResult.ok).toBe(false)
    if (!brandResult.ok) expect(brandResult.code).toBe("malformed_claims")
  })

  test("rejects insecure URLs except opted-in loopback", () => {
    const insecureClaims = baseClaims({ den: { baseUrl: "http://intranet.acme.example.com", apiBaseUrl: null } })
    const insecureToken = signConnectLinkToken({
      claims: insecureClaims,
      privateKeyPem,
      kid: KID,
      allowInsecureUrls: true,
    })
    const rejected = verifyAt(insecureToken)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe("insecure_url")
    const stillRejected = verifyConnectLinkToken({
      token: insecureToken,
      publicKeys: PUBLIC_KEYS,
      nowEpochSeconds: NOW,
      allowInsecureLoopback: true,
    })
    expect(stillRejected.ok).toBe(false)

    const loopbackClaims = baseClaims({ den: { baseUrl: "http://127.0.0.1:8788", apiBaseUrl: null } })
    const loopbackToken = signConnectLinkToken({
      claims: loopbackClaims,
      privateKeyPem,
      kid: KID,
      allowInsecureUrls: true,
    })
    const loopbackRejected = verifyAt(loopbackToken)
    expect(loopbackRejected.ok).toBe(false)
    const loopbackAllowed = verifyConnectLinkToken({
      token: loopbackToken,
      publicKeys: PUBLIC_KEYS,
      nowEpochSeconds: NOW,
      allowInsecureLoopback: true,
    })
    expect(loopbackAllowed.ok).toBe(true)

    const mixedToken = signConnectLinkToken({
      claims: baseClaims({
        den: {
          baseUrl: "http://127.0.0.1:8788",
          apiBaseUrl: "http://intranet.acme.example.com/api",
        },
      }),
      privateKeyPem,
      kid: KID,
      allowInsecureUrls: true,
    })
    const mixedRejected = verifyConnectLinkToken({
      token: mixedToken,
      publicKeys: PUBLIC_KEYS,
      nowEpochSeconds: NOW,
      allowInsecureLoopback: true,
    })
    expect(mixedRejected.ok).toBe(false)
    if (!mixedRejected.ok) expect(mixedRejected.code).toBe("insecure_url")

    const insecureIcon = signConnectLinkToken({
      claims: baseClaims({
        brand: {
          appName: "Acme Work",
          logoUrl: null,
          iconUrl: "http://cdn.acme.example.com/icon.png",
        },
      }),
      privateKeyPem,
      kid: KID,
      allowInsecureUrls: true,
    })
    const iconRejected = verifyAt(insecureIcon)
    expect(iconRejected.ok).toBe(false)
    if (!iconRejected.ok) expect(iconRejected.code).toBe("insecure_url")
  })
})

describe("claim helpers", () => {
  test("schema and insecure-url helper agree with the type", () => {
    const claims = baseClaims()
    expect(connectLinkClaimsSchema.parse(claims)).toEqual(claims)
    expect(findInsecureConnectLinkUrl(claims)).toBeNull()
    expect(
      findInsecureConnectLinkUrl(baseClaims({
        brand: {
          appName: "Acme Work",
          logoUrl: "http://cdn.acme.example.com/logo.svg",
          iconUrl: null,
        },
      })),
    ).toBe("http://cdn.acme.example.com/logo.svg")
  })

  test("buildConnectDeepLink emits the connect route", () => {
    expect(buildConnectDeepLink("abc.def.ghi")).toBe("openwork://connect?token=abc.def.ghi")
    expect(buildConnectDeepLink("abc", "openwork-dev")).toBe("openwork-dev://connect?token=abc")
  })
})
