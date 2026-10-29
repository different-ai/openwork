import * as Crypto from "expo-crypto"

/** RFC 4648 base64url, unpadded. */
function base64url(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  let out = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += alphabet[(triple >> 18) & 63]
    out += alphabet[(triple >> 12) & 63]
    if (index + 1 < bytes.length) out += alphabet[(triple >> 6) & 63]
    if (index + 2 < bytes.length) out += alphabet[triple & 63]
  }
  return out
}

export const randomBytes = (length: number) => Crypto.getRandomBytes(length)

/**
 * A PKCE pair (RFC 7636, S256) and a state for one sign-in. The verifier never leaves this phone until the app trades
 * Den's code for its session.
 */
export async function newSignIn() {
  const verifier = base64url(randomBytes(32))
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)), state: base64url(randomBytes(24)) }
}
