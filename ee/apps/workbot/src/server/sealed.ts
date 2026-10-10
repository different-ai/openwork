import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { z } from "zod"

/**
 * Workbot keeps no sign-in state on its own disk, so any number of instances can serve anyone. What it needs to
 * remember lives in the browser, encrypted and authenticated with WORKBOT_SESSION_SECRET (AES-256-GCM): the person's
 * Den tokens, and a sign-in in progress. The browser can neither read nor change them, and a cookie made for one
 * purpose never opens as another. Changing the secret signs everyone out.
 */

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }
export const tokensSchema = z.object({ accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number() })
export const sessionSchema = z.object({ id: z.string(), userId: z.string(), organizationId: z.string(), tokens: tokensSchema, createdAt: z.number() })

/** Browsers drop a cookie over 4096 bytes; stop well before that instead of signing someone in to a lost cookie. */
export const MAX_COOKIE_VALUE = 3_800

export const randomToken = () => randomBytes(32).toString("base64url")

export type Sealer = {
  seal(purpose: string, value: unknown): string
  open<T>(purpose: string, sealed: string | undefined, schema: z.ZodType<T>): T | null
}

export function createSealer(secret: string): Sealer {
  const key = createHash("sha256").update(`workbot-cookie:${secret}`).digest()
  return {
    seal(purpose, value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(Buffer.from(purpose))
      const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
      return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".")
    },
    open(purpose, sealed, schema) {
      if (!sealed) return null
      try {
        const [iv, tag, body, extra] = sealed.split(".").map((part) => Buffer.from(part, "base64url"))
        if (!iv || !tag || !body || extra) return null
        const decipher = createDecipheriv("aes-256-gcm", key, iv)
        decipher.setAAD(Buffer.from(purpose))
        decipher.setAuthTag(tag)
        const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
        const parsed = schema.safeParse(JSON.parse(text))
        return parsed.success ? parsed.data : null
      } catch {
        // Another secret (rotated), another purpose, or a damaged cookie: treated as absent.
        return null
      }
    },
  }
}
