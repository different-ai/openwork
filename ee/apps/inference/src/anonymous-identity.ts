// Bounded reuse from #4621, 401267fc: hashed identities and encrypted tokens.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { isIP } from "node:net"
import { getConnInfo } from "@hono/node-server/conninfo"
import type { Context } from "hono"
import { env } from "./env.js"
import type { DesktopFreeBinding } from "./desktop-free-proof.js"

export type AnonymousIdentities = {
  installationHash: string
  ipHash: string
  globalHash: string
}

type AnonymousTokenPayload = AnonymousIdentities & DesktopFreeBinding & {
  expiresAt: number
  issuedAt: number
}

function anonymousSecret() {
  if (!env.anonymous.tokenSecret) throw new Error("Anonymous inference token secret is unavailable")
  return env.anonymous.tokenSecret
}

function accountingIdentityKey() {
  if (!env.anonymous.accountingIdentityKey) throw new Error("Anonymous inference accounting identity key is unavailable")
  return env.anonymous.accountingIdentityKey
}

function hashIdentity(kind: "installation" | "ip" | "global", value: string) {
  return createHmac("sha256", accountingIdentityKey()).update(`${kind}:${value}`, "utf8").digest("hex")
}

function normalizeIpv4(value: string) {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const numbers = parts.map(Number)
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return numbers.join(".")
}

function ipv4TailGroups(value: string) {
  const ipv4 = normalizeIpv4(value)
  if (!ipv4) return null
  const parts = ipv4.split(".").map(Number)
  return [((parts[0] ?? 0) << 8) + (parts[1] ?? 0), ((parts[2] ?? 0) << 8) + (parts[3] ?? 0)]
}

function expandIpv6(value: string) {
  const [leftValue, rightValue, ...extra] = value.split("::")
  if (extra.length > 0) return null
  const readSide = (side: string) => {
    if (!side) return []
    const groups: number[] = []
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const tail = ipv4TailGroups(part)
        if (!tail) return null
        groups.push(...tail)
        continue
      }
      const parsed = Number.parseInt(part, 16)
      if (!part || part.length > 4 || !Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null
      groups.push(parsed)
    }
    return groups
  }
  const left = readSide(leftValue ?? "")
  const right = readSide(rightValue ?? "")
  if (!left || !right) return null
  if (!value.includes("::")) return left.length === 8 ? left : null
  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

export function canonicalizeAnonymousAddress(input: string) {
  let value = input.trim().toLowerCase()
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1)
  value = value.split("%", 1)[0] ?? ""
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4) return normalizeIpv4(value.slice(7))
  const version = isIP(value)
  if (version === 4) return normalizeIpv4(value)
  if (version !== 6) return null
  const groups = expandIpv6(value)
  if (!groups) return null
  return groups.map((group) => group.toString(16).padStart(4, "0")).join(":")
}

function anonymousQuotaAddress(canonicalAddress: string) {
  if (!canonicalAddress.includes(":")) return canonicalAddress
  return `${canonicalAddress.split(":").slice(0, 4).join(":")}::/64`
}

export function resolveAnonymousClientAddress(c: Context) {
  const socketAddress = canonicalizeAnonymousAddress(getConnInfo(c).remote.address ?? "")
  if (!socketAddress) return null
  if (env.anonymous.trustProxyHops === 0) return anonymousQuotaAddress(socketAddress)

  // Trust full canonical proxy addresses before aggregating IPv6 clients to /64.
  const trusted = new Set(env.anonymous.trustedProxyIps.map(canonicalizeAnonymousAddress))
  if (trusted.has(null) || trusted.size === 0) return null
  const forwarded = c.req.raw.headers.get("x-forwarded-for")
  if (!forwarded) return null
  const chain = forwarded.split(",").map(canonicalizeAnonymousAddress)
  if (chain.some((address) => address === null)) return null
  const addresses = chain.filter((address) => address !== null)
  addresses.push(socketAddress)
  const clientIndex = addresses.length - 1 - env.anonymous.trustProxyHops
  if (clientIndex < 0) return null
  for (let offset = 0; offset < env.anonymous.trustProxyHops; offset += 1) {
    const proxy = addresses[addresses.length - 1 - offset]
    if (!proxy || !trusted.has(proxy)) return null
  }
  const clientAddress = addresses[clientIndex]
  return clientAddress ? anonymousQuotaAddress(clientAddress) : null
}

export function createAnonymousIdentities(proof: Pick<DesktopFreeBinding, "keyThumbprint">, normalizedAddress: string): AnonymousIdentities {
  if (!/^[a-f0-9]{64}$/.test(proof.keyThumbprint)) throw new Error("A verified Ed25519 key thumbprint is required")
  return {
    // Registration's compatibility UUID is not quota identity. Reusing a native
    // key must reuse its allowance even if the caller changes that UUID.
    installationHash: hashIdentity("installation", `ed25519:${proof.keyThumbprint}`),
    ipHash: hashIdentity("ip", normalizedAddress),
    globalHash: hashIdentity("global", "openwork-free-allowance"),
  }
}

function tokenKey() {
  return Uint8Array.from(createHash("sha256").update(anonymousSecret(), "utf8").digest())
}

function concatBytes(values: Uint8Array[]) {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

export function issueAnonymousToken(identities: AnonymousIdentities, binding: DesktopFreeBinding, now = Date.now()) {
  const expiresAt = now + env.anonymous.tokenTtlSeconds * 1000
  const payload = JSON.stringify({
    version: 2,
    installationHash: identities.installationHash,
    ipHash: identities.ipHash,
    globalHash: identities.globalHash,
    keyThumbprint: binding.keyThumbprint,
    appVersion: binding.appVersion,
    platform: binding.platform,
    arch: binding.arch,
    issuedAt: now,
    expiresAt,
  })
  const iv = Uint8Array.from(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv)
  const encrypted = concatBytes([Uint8Array.from(cipher.update(payload, "utf8")), Uint8Array.from(cipher.final())])
  const packed = concatBytes([iv, Uint8Array.from(cipher.getAuthTag()), encrypted])
  const token = Buffer.from(packed).toString("base64url")
  return { token: `ow_guest_v2.${token}`, expiresAt }
}

function readTokenPayload(value: unknown): AnonymousTokenPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  if (!("version" in value) || value.version !== 2) return null
  if (!("installationHash" in value) || typeof value.installationHash !== "string" || !/^[a-f0-9]{64}$/.test(value.installationHash)) return null
  if (!("ipHash" in value) || typeof value.ipHash !== "string" || !/^[a-f0-9]{64}$/.test(value.ipHash)) return null
  if (!("globalHash" in value) || typeof value.globalHash !== "string" || !/^[a-f0-9]{64}$/.test(value.globalHash)) return null
  if (!("keyThumbprint" in value) || typeof value.keyThumbprint !== "string" || !/^[a-f0-9]{64}$/.test(value.keyThumbprint)) return null
  if (!("appVersion" in value) || typeof value.appVersion !== "string" || !value.appVersion || value.appVersion.length > 128) return null
  if (!("platform" in value) || (value.platform !== "darwin" && value.platform !== "win32" && value.platform !== "linux")) return null
  if (!("arch" in value) || (value.arch !== "arm64" && value.arch !== "x64")) return null
  if (!("issuedAt" in value) || typeof value.issuedAt !== "number" || !Number.isSafeInteger(value.issuedAt)) return null
  if (!("expiresAt" in value) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) return null
  return {
    installationHash: value.installationHash,
    ipHash: value.ipHash,
    globalHash: value.globalHash,
    keyThumbprint: value.keyThumbprint,
    appVersion: value.appVersion,
    platform: value.platform,
    arch: value.arch,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  }
}

function constantTimeHashEqual(left: string, right: string) {
  const leftBytes = Uint8Array.from(Buffer.from(left, "hex"))
  const rightBytes = Uint8Array.from(Buffer.from(right, "hex"))
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function verifyAnonymousToken(token: string, normalizedAddress: string, now = Date.now()) {
  if (!token.startsWith("ow_guest_v2.") || token.length > 2048) return null
  try {
    const packed = Uint8Array.from(Buffer.from(token.slice("ow_guest_v2.".length), "base64url"))
    if (packed.length <= 28) return null
    const iv = packed.subarray(0, 12)
    const tag = packed.subarray(12, 28)
    const encrypted = packed.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(), iv)
    decipher.setAuthTag(tag)
    const decrypted = concatBytes([Uint8Array.from(decipher.update(encrypted)), Uint8Array.from(decipher.final())])
    const text = new TextDecoder().decode(decrypted)
    const payload = readTokenPayload(JSON.parse(text))
    if (!payload || payload.expiresAt <= now || payload.issuedAt > now + 30_000) return null
    const currentInstallationHash = hashIdentity("installation", `ed25519:${payload.keyThumbprint}`)
    const currentIpHash = hashIdentity("ip", normalizedAddress)
    const currentGlobalHash = hashIdentity("global", "openwork-free-allowance")
    if (!constantTimeHashEqual(payload.installationHash, currentInstallationHash)
      || !constantTimeHashEqual(payload.ipHash, currentIpHash) || !constantTimeHashEqual(payload.globalHash, currentGlobalHash)) return null
    return payload
  } catch {
    return null
  }
}
