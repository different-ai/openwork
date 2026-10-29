import { createCipheriv, createDecipheriv, createHmac, createSecretKey, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import { env } from "../env.js"

// Short-lived bearer tokens for file transfers. Each kind has its own domain,
// so a token issued for one purpose is never accepted for another.

type Expiring = { e: number }

function signature(domain: string, encoded: string) {
  return createHmac("sha256", env.betterAuthSecret).update(domain).update("\0").update(encoded).digest("base64url")
}

function unexpired<T extends Expiring>(value: unknown, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(value)
  if (!parsed.success || parsed.data.e * 1000 < Date.now()) return null
  return parsed.data
}

/** Signed but readable: the payload names its member, file and expiry (`e`, in seconds). */
export function signLink<T extends Expiring>(domain: string, payload: T): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${signature(domain, encoded)}`
}

export function verifyLink<T extends Expiring>(domain: string, token: string, schema: z.ZodType<T>): T | null {
  const [encoded, received, extra] = token.split(".")
  if (!encoded || !received || extra !== undefined) return null
  const expected = new TextEncoder().encode(signature(domain, encoded))
  const actual = new TextEncoder().encode(received)
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return null
  try {
    return unexpired(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), schema)
  } catch {
    return null
  }
}

function sealingKey(domain: string) {
  return createSecretKey(new Uint8Array(hkdfSync("sha256", env.betterAuthSecret, "", domain, 32)))
}

/** Encrypted and authenticated, for payloads the bearer must not read, such as a provider's upload session URL. */
export function sealToken<T extends Expiring>(domain: string, payload: T): string {
  const iv = new Uint8Array(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", sealingKey(domain), iv)
  const sealed = [new Uint8Array(cipher.update(JSON.stringify(payload), "utf8")), new Uint8Array(cipher.final())]
  return Buffer.concat([iv, new Uint8Array(cipher.getAuthTag()), ...sealed]).toString("base64url")
}

export function openToken<T extends Expiring>(domain: string, token: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = new Uint8Array(Buffer.from(token, "base64url"))
    if (raw.byteLength < 29) return null
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(domain), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    const opened = Buffer.concat([new Uint8Array(decipher.update(raw.subarray(28))), new Uint8Array(decipher.final())]).toString("utf8")
    return unexpired(JSON.parse(opened), schema)
  } catch {
    return null
  }
}
