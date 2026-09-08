import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import {
  DESKTOP_FREE_PROOF_CLOCK_SKEW_MS,
  DESKTOP_FREE_PROOF_MAX_BYTES,
  desktopFreeProofMessage,
  type DesktopFreeProofClaims,
} from "@openwork/types/desktop-free-access"

const proofSchema = z.strictObject({
  version: z.literal(1),
  publicKey: z.string().length(60).regex(/^[A-Za-z0-9+/]+=$/),
  appVersion: z.string().min(1).max(128),
  platform: z.enum(["darwin", "win32", "linux"]),
  arch: z.enum(["arm64", "x64"]),
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonce: z.string().uuid(),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
})

export type DesktopFreeBinding = Pick<DesktopFreeProofClaims, "appVersion" | "platform" | "arch"> & {
  keyThumbprint: string
}

export function desktopFreeHash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

export function verifyDesktopFreeProof(input: {
  header: string | null
  method: string
  path: string
  bodyHash: string
  authorization: string
  binding?: DesktopFreeBinding
  now?: number
}): (DesktopFreeProofClaims & DesktopFreeBinding) | null {
  try {
    if (!input.header || input.header.length > DESKTOP_FREE_PROOF_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(input.header)) return null
    const encoded = Buffer.from(input.header, "base64url")
    if (encoded.toString("base64url") !== input.header) return null
    const parsed = proofSchema.safeParse(JSON.parse(encoded.toString("utf8")))
    if (!parsed.success) return null
    const { signature, ...proof } = parsed.data
    if (Math.abs((input.now ?? Date.now()) - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return null
    const der = Buffer.from(proof.publicKey, "base64")
    if (der.toString("base64") !== proof.publicKey) return null
    const key = createPublicKey({ key: der, format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64") !== proof.publicKey) return null
    const keyThumbprint = desktopFreeHash(Uint8Array.from(der))
    if (input.binding && (input.binding.keyThumbprint !== keyThumbprint
      || input.binding.appVersion !== proof.appVersion || input.binding.platform !== proof.platform
      || input.binding.arch !== proof.arch)) return null
    const signatureBytes = Buffer.from(signature, "base64url")
    if (signatureBytes.toString("base64url") !== signature) return null
    const message = desktopFreeProofMessage({
      ...proof, method: input.method, path: input.path, bodyHash: input.bodyHash,
      authorizationHash: desktopFreeHash(input.authorization),
    })
    if (!verify(null, new TextEncoder().encode(message), key, Uint8Array.from(signatureBytes))) return null
    return { ...proof, keyThumbprint }
  } catch {
    return null
  }
}
