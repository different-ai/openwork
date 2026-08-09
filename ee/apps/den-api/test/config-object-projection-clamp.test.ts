import { expect, test } from "bun:test"
import {
  clampCodePoints,
  clampUtf8Bytes,
  PROJECTION_TEXT_MAX_BYTES,
  PROJECTION_TITLE_MAX_CHARS,
} from "../src/routes/org/plugin-system/projection-text.js"

const MYSQL_TEXT_MAX_BYTES = 65_535

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function roundTripsCleanly(value: string) {
  return Buffer.from(value, "utf8").toString("utf8") === value
}

test("clampUtf8Bytes leaves values within budget untouched", () => {
  expect(clampUtf8Bytes("short", 100)).toBe("short")
  expect(clampUtf8Bytes("", 100)).toBe("")
  const exact = "a".repeat(100)
  expect(clampUtf8Bytes(exact, 100)).toBe(exact)
})

test("clampUtf8Bytes never splits a two-byte code point", () => {
  // "é" is 2 bytes in UTF-8; a 5-byte budget fits two of them, not two and a half.
  expect(clampUtf8Bytes("ééé", 5)).toBe("éé")
  expect(utf8Bytes(clampUtf8Bytes("ééé", 5))).toBe(4)
})

test("clampUtf8Bytes never splits a surrogate pair", () => {
  // "💚" is 4 UTF-8 bytes and one surrogate pair; a 6-byte budget fits one.
  const clamped = clampUtf8Bytes("💚💚", 6)
  expect(clamped).toBe("💚")
  expect(roundTripsCleanly(clamped)).toBe(true)
})

test("clampUtf8Bytes keeps multibyte production payloads under the MySQL TEXT cap", () => {
  const sentence = "Orchestre le développement complet d'apps mobiles — idée, validation, croissance, déploiement. "
  const cjk = "大小阈值测试：这是用于探测载荷大小阈值的测试文本。"
  let oversized = ""
  while (utf8Bytes(oversized) <= MYSQL_TEXT_MAX_BYTES + 10_000) oversized += sentence + cjk
  expect(utf8Bytes(oversized)).toBeGreaterThan(MYSQL_TEXT_MAX_BYTES)

  const clamped = clampUtf8Bytes(oversized, PROJECTION_TEXT_MAX_BYTES)
  expect(utf8Bytes(clamped)).toBeLessThanOrEqual(PROJECTION_TEXT_MAX_BYTES)
  expect(utf8Bytes(clamped)).toBeGreaterThan(PROJECTION_TEXT_MAX_BYTES - 8)
  expect(PROJECTION_TEXT_MAX_BYTES).toBeLessThanOrEqual(MYSQL_TEXT_MAX_BYTES)
  expect(oversized.startsWith(clamped)).toBe(true)
  expect(roundTripsCleanly(clamped)).toBe(true)
})

test("clampCodePoints counts code points, not UTF-16 units", () => {
  expect(clampCodePoints("abc", 5)).toBe("abc")
  const emojiTitle = "💚".repeat(PROJECTION_TITLE_MAX_CHARS + 45)
  const clamped = clampCodePoints(emojiTitle, PROJECTION_TITLE_MAX_CHARS)
  expect([...clamped].length).toBe(PROJECTION_TITLE_MAX_CHARS)
  expect(roundTripsCleanly(clamped)).toBe(true)
})
