import assert from "node:assert/strict"

// Independent decoder (TypeID suffix -> UUID) so the converter's encoder is
// checked against a second implementation rather than against itself.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export function legacyUuidOf(typeId: string): string {
  let value = 0n
  for (const char of typeId.slice(typeId.lastIndexOf("_") + 1)) {
    const digit = ALPHABET.indexOf(char)
    assert.ok(digit >= 0)
    value = value * 32n + BigInt(digit)
  }
  const hex = value.toString(16).padStart(32, "0")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
