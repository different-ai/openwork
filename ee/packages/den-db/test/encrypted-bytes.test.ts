import assert from "node:assert/strict"
import test from "node:test"

process.env.DEN_DB_ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters"
const { decryptDatabaseBytes, encryptDatabaseBytes } = await import("../src/columns.ts")

test("binary values round-trip through encryption at rest, and tampering is caught", () => {
  const value = new Uint8Array([0, 1, 2, 250, 255, 0x89, 0x50, 0x4e, 0x47])
  const encrypted = encryptDatabaseBytes(value)
  assert.equal(encrypted.byteLength, value.byteLength + 35)
  assert.notDeepEqual([...encrypted.subarray(35)], [...value])
  assert.deepEqual([...decryptDatabaseBytes(encrypted)], [...value])
  // A fresh IV each time.
  assert.notDeepEqual([...encryptDatabaseBytes(value)], [...encrypted])
  assert.deepEqual([...decryptDatabaseBytes(encryptDatabaseBytes(new Uint8Array()))], [])

  const tampered = Uint8Array.from(encrypted)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => decryptDatabaseBytes(tampered))
  assert.throws(() => decryptDatabaseBytes(value), /supported prefix/)
})
