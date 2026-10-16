import { createHash } from "node:crypto"

/**
 * Resume grants at rest: AES-256-GCM with a random IV, keyed by SHA-256("headless-grant:" + HEADLESS_GRANT_KEY).
 * Web Crypto, because both hosts have it (celld has no `createCipheriv`). A value that doesn't open (another key, a
 * damaged row) is no grant at all: that turn simply waits for its caller, as without self-resume.
 */
export type GrantVault = {
  seal(grant: string): Promise<string>
  open(sealed: string): Promise<string | null>
}

const VERSION = "v1"
const IV_BYTES = 12

export function grantVault(secret: string): GrantVault {
  let key: Promise<CryptoKey> | null = null
  const keyOf = () => {
    key ??= crypto.subtle.importKey("raw", new Uint8Array(createHash("sha256").update(`headless-grant:${secret}`).digest()), "AES-GCM", false, ["encrypt", "decrypt"])
    return key
  }
  return {
    async seal(grant) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(), new TextEncoder().encode(grant))
      return `${VERSION}.${Buffer.from(iv).toString("base64url")}.${Buffer.from(sealed).toString("base64url")}`
    },
    async open(sealed) {
      const [version, iv, data, ...rest] = sealed.split(".")
      if (version !== VERSION || !iv || !data || rest.length) return null
      try {
        const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(Buffer.from(iv, "base64url")) }, await keyOf(), new Uint8Array(Buffer.from(data, "base64url")))
        return new TextDecoder().decode(opened)
      } catch {
        return null
      }
    },
  }
}
