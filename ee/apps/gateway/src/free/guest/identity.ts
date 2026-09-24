import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import { getConnInfo } from "@hono/node-server/conninfo"
import type { Context } from "hono"
import { z } from "zod"
import type { AutoConfig } from "../shared/config.js"
import type { DesktopFreeBinding } from "./proof.js"

export type AnonymousIdentities = { installationHash: string; ipHash: string; globalHash: string }
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const tokenSchema = z.strictObject({ version: z.literal(3), installationHash: hash, ipHash: hash, globalHash: hash,
  keyThumbprint: hash, machineId: hash, appVersion: z.string().min(1).max(128), platform: z.enum(["darwin", "win32", "linux"]),
  arch: z.enum(["arm64", "x64"]), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() })
function hashIdentity(config: AutoConfig, kind: string, value: string) {
  if (config.accountingIdentityKey.length < 32) throw new Error("Free accounting identity unavailable")
  return createHmac("sha256", config.accountingIdentityKey).update(`${kind}:${value}`).digest("hex")
}

export function canonicalizeAnonymousAddress(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1)
  value = value.split("%", 1)[0] ?? ""
  if (isIP(value) === 4) return value.split(".").map(Number).join(".")
  if (isIP(value) !== 6) return null
  const side = (text: string) => text ? text.split(":").flatMap((part) => {
    if (!part.includes(".")) return [Number.parseInt(part, 16)]
    const octets = part.split(".").map(Number)
    return [(octets[0] << 8) + octets[1], (octets[2] << 8) + octets[3]]
  }) : []
  const [left = "", right = ""] = value.split("::")
  const a = side(left), b = side(right)
  const groups = value.includes("::") ? [...a, ...Array.from({ length: 8 - a.length - b.length }, () => 0), ...b] : a
  if (groups.length !== 8) return null
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 65535) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".")
  }
  return groups.map((part) => part.toString(16).padStart(4, "0")).join(":")
}
function quotaAddress(address: string) { return address.includes(":") ? `${address.split(":").slice(0, 4).join(":")}::/64` : address }
export function resolveAnonymousClientAddress(c: Context, config: AutoConfig) {
  const socket = canonicalizeAnonymousAddress(getConnInfo(c).remote.address ?? "")
  if (!socket) return null
  if (config.trustProxyHops === 0) return quotaAddress(socket)
  const trusted = new Set(config.trustedProxyIps.map(canonicalizeAnonymousAddress))
  if (trusted.has(null) || trusted.size === 0) return null
  const forwarded = c.req.header("x-forwarded-for")
  if (!forwarded) return null
  const chain = [...forwarded.split(",").map(canonicalizeAnonymousAddress), socket]
  const index = chain.length - 1 - config.trustProxyHops
  if (index < 0 || chain.includes(null)) return null
  for (let offset = 0; offset < config.trustProxyHops; offset++) {
    if (!trusted.has(chain[chain.length - 1 - offset])) return null
  }
  const address = chain[index]
  return address ? quotaAddress(address) : null
}
export function anonymousIpHash(address: string, config: AutoConfig) { return hashIdentity(config, "ip", address) }
/** The allowance follows the machine, so reinstalling or clearing app data does not reset it. */
export function createAnonymousIdentities(proof: Pick<DesktopFreeBinding, "machineId">, address: string, config: AutoConfig): AnonymousIdentities {
  return { installationHash: hashIdentity(config, "installation", `machine:${proof.machineId}`),
    ipHash: anonymousIpHash(address, config), globalHash: hashIdentity(config, "global", "openwork-free-allowance") }
}
function tokenKey(config: AutoConfig) {
  if (config.tokenSecret.length < 32) throw new Error("Free token secret unavailable")
  return Uint8Array.from(createHash("sha256").update(config.tokenSecret).digest())
}
export function issueAnonymousToken(identities: AnonymousIdentities, binding: DesktopFreeBinding, config: AutoConfig, now = Date.now()) {
  const expiresAt = now + config.tokenTtlSeconds * 1000
  const payload = JSON.stringify({ version: 3, ...identities, keyThumbprint: binding.keyThumbprint, machineId: binding.machineId,
    appVersion: binding.appVersion, platform: binding.platform, arch: binding.arch, issuedAt: now, expiresAt })
  const iv = Uint8Array.from(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", tokenKey(config), iv)
  const encrypted = [Uint8Array.from(cipher.update(payload, "utf8")), Uint8Array.from(cipher.final())]
  return { token: `ow_guest_v3.${Buffer.concat([iv, Uint8Array.from(cipher.getAuthTag()), ...encrypted]).toString("base64url")}`, expiresAt }
}
export function verifyAnonymousToken(token: string, address: string, config: AutoConfig, now = Date.now()) {
  if (!token.startsWith("ow_guest_v3.") || token.length > 2048) return null
  try {
    const encoded = token.slice("ow_guest_v3.".length)
    const packed = Buffer.from(encoded, "base64url")
    if (packed.length <= 28 || packed.toString("base64url") !== encoded) return null
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(config), Uint8Array.from(packed.subarray(0, 12)))
    decipher.setAuthTag(Uint8Array.from(packed.subarray(12, 28)))
    const decoded = Buffer.concat([Uint8Array.from(decipher.update(Uint8Array.from(packed.subarray(28)))), Uint8Array.from(decipher.final())]).toString("utf8")
    const parsed = tokenSchema.safeParse(JSON.parse(decoded))
    if (!parsed.success) return null
    const payload = parsed.data
    if (payload.expiresAt <= now || payload.issuedAt > now + 30000 || payload.expiresAt <= payload.issuedAt) return null
    const expected = createAnonymousIdentities(payload, address, config)
    for (const name of ["installationHash", "ipHash", "globalHash"] as const) {
      if (!timingSafeEqual(Uint8Array.from(Buffer.from(payload[name], "hex")), Uint8Array.from(Buffer.from(expected[name], "hex")))) return null
    }
    return payload
  } catch { return null }
}
