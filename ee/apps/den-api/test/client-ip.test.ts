import assert from "node:assert/strict"
import { test } from "node:test"
import { CLIENT_IP_SIGNATURE_HEADER, SIGNED_CLIENT_IP_HEADER, signClientIp } from "@openwork-ee/utils/client-ip-signature"
import {
  DEFAULT_CLIENT_IP_HEADERS,
  normalizeClientIp,
  RESOLVED_CLIENT_IP_HEADER,
  resolveClientIp,
  withResolvedClientIp,
  type ClientIpOptions,
} from "../src/client-ip.js"

const defaults: ClientIpOptions = { headers: DEFAULT_CLIENT_IP_HEADERS, trustedProxies: [] }

function headers(values: Record<string, string>) {
  return new Headers(values)
}

test("a single x-forwarded-for entry is the client", () => {
  assert.deepEqual(resolveClientIp(headers({ "x-forwarded-for": "198.51.100.7" }), defaults), { ip: "198.51.100.7", source: "header", header: "x-forwarded-for" })
})

test("a multi-entry x-forwarded-for is not trusted without trusted proxies; the next header is used", () => {
  const request = headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.250", "x-real-ip": "198.51.100.7" })
  assert.deepEqual(resolveClientIp(request, defaults), { ip: "198.51.100.7", source: "header", header: "x-real-ip" })
})

test("with trusted proxies, the right-most untrusted x-forwarded-for hop is the client", () => {
  const options = { ...defaults, trustedProxies: ["10.0.0.0/8", "2001:db8::/32"] }
  const chain = headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7, 10.1.2.3, 2001:db8::1" })
  assert.equal(resolveClientIp(chain, options).ip, "198.51.100.7")
  assert.equal(resolveClientIp(headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }), options).ip, null)
})

test("no usable header means no address, never a guess", () => {
  assert.deepEqual(resolveClientIp(headers({ "x-real-ip": "unknown" }), defaults), { ip: null, source: "none", header: null })
  assert.equal(resolveClientIp(headers({ [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4" }), { ...defaults, headers: [RESOLVED_CLIENT_IP_HEADER] }).ip, null)
})

test("addresses are normalized: IPv6 to its /64, mapped IPv4 unwrapped, garbage rejected", () => {
  assert.equal(normalizeClientIp("2001:DB8:1:2:3:4:5:6"), "2001:0db8:0001:0002:0000:0000:0000:0000")
  assert.equal(normalizeClientIp("2001:db8:1:2::9"), "2001:0db8:0001:0002:0000:0000:0000:0000")
  assert.equal(normalizeClientIp("::ffff:198.51.100.7"), "198.51.100.7")
  assert.equal(normalizeClientIp("unknown"), null)
  assert.equal(normalizeClientIp("198.51.100.7:443"), null)
})

test("Better Auth receives only the resolved address, never a caller-supplied one", async () => {
  const request = new Request("https://den.example/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4", "x-real-ip": "198.51.100.7" },
    body: JSON.stringify({ email: "a@example.com" }),
  })
  const rewritten = withResolvedClientIp(request, resolveClientIp(request.headers, defaults))
  assert.equal(rewritten.headers.get(RESOLVED_CLIENT_IP_HEADER), "198.51.100.7")
  assert.deepEqual(await rewritten.json(), { email: "a@example.com" })

  const spoofed = new Request("https://den.example/api/auth/get-session", { headers: { [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4" } })
  const unresolved = withResolvedClientIp(spoofed, { ip: null, source: "none", header: null })
  assert.equal(unresolved.headers.get(RESOLVED_CLIENT_IP_HEADER), null)
})

const secret = "den-web-client-ip-secret-for-tests-0123456789"
const signedOptions: ClientIpOptions = { ...defaults, trustedProxies: ["10.0.0.0/8"], signedClientIpSecret: secret }

test("an address Den Web signed wins over the proxy chain that only names Den Web's host", () => {
  const forwarded = headers({
    "x-forwarded-for": "198.51.100.7, 3.91.20.15, 10.1.2.3",
    "cf-connecting-ip": "3.91.20.15",
    [SIGNED_CLIENT_IP_HEADER]: "198.51.100.7",
    [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(secret, "198.51.100.7"),
  })
  assert.deepEqual(resolveClientIp(forwarded, signedOptions), { ip: "198.51.100.7", source: "signed", header: SIGNED_CLIENT_IP_HEADER })
  assert.equal(resolveClientIp(forwarded, { ...signedOptions, signedClientIpSecret: null }).ip, "3.91.20.15", "without the secret the chain decides, as before")
})

test("a signed address needs the right secret, the same address and a fresh signature", () => {
  const signed = (ip: string, signature: string) => headers({ "x-forwarded-for": "3.91.20.15", [SIGNED_CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: signature })
  const now = Date.UTC(2026, 9, 24, 12)
  const fallback = { ip: "3.91.20.15", source: "header", header: "x-forwarded-for" }
  assert.deepEqual(resolveClientIp(signed("198.51.100.7", signClientIp(`${secret}-other`, "198.51.100.7", now)), { ...signedOptions, now }), fallback)
  assert.deepEqual(resolveClientIp(signed("198.51.100.8", signClientIp(secret, "198.51.100.7", now)), { ...signedOptions, now }), fallback)
  assert.deepEqual(resolveClientIp(signed("198.51.100.7", signClientIp(secret, "198.51.100.7", now - 600_000)), { ...signedOptions, now }), fallback)
  assert.deepEqual(resolveClientIp(signed("198.51.100.7", ""), { ...signedOptions, now }), fallback, "a caller's own unsigned claim is ignored")
  assert.equal(resolveClientIp(signed("not an address", signClientIp(secret, "not an address", now)), { ...signedOptions, now }).ip, "3.91.20.15")
})

test("a signed IPv6 address is reduced to its /64 like any other", () => {
  const signed = headers({ [SIGNED_CLIENT_IP_HEADER]: "2001:db8:1:2::9", [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(secret, "2001:db8:1:2::9") })
  assert.equal(resolveClientIp(signed, signedOptions).ip, "2001:0db8:0001:0002:0000:0000:0000:0000")
})
