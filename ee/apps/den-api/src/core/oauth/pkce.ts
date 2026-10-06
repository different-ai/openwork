import { createHash, randomBytes } from "node:crypto"

export function base64UrlEncode(input: Buffer | string) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64url")
}

export function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}
