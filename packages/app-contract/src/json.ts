// Strict JSON parsing for security-relevant documents.
//
// `JSON.parse` silently keeps the last of a duplicated key. That is a classic
// parser-differential: a manifest can be written so a linter reads one
// permission set and the installer reads another. This parser rejects duplicate
// keys outright, and rejects the byte-order mark and trailing content that some
// editors add.
//
// It is intentionally small and total — it returns a typed failure rather than
// throwing, and it is only used on documents already bounded in size.

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; offset: number }

type Cursor = { text: string; index: number }

const WHITESPACE = new Set([" ", "\t", "\n", "\r"])

function skipWhitespace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && WHITESPACE.has(cursor.text[cursor.index] as string)) {
    cursor.index += 1
  }
}

class JsonError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message)
  }
}

function fail(cursor: Cursor, message: string): never {
  throw new JsonError(message, cursor.index)
}

function parseValue(cursor: Cursor, depth: number): unknown {
  if (depth > 64) fail(cursor, "JSON nesting is too deep")
  skipWhitespace(cursor)
  const char = cursor.text[cursor.index]
  if (char === undefined) fail(cursor, "unexpected end of input")
  if (char === "{") return parseObject(cursor, depth)
  if (char === "[") return parseArray(cursor, depth)
  if (char === '"') return parseString(cursor)
  if (char === "-" || (char >= "0" && char <= "9")) return parseNumber(cursor)
  if (cursor.text.startsWith("true", cursor.index)) {
    cursor.index += 4
    return true
  }
  if (cursor.text.startsWith("false", cursor.index)) {
    cursor.index += 5
    return false
  }
  if (cursor.text.startsWith("null", cursor.index)) {
    cursor.index += 4
    return null
  }
  fail(cursor, `unexpected character ${JSON.stringify(char)}`)
}

function parseObject(cursor: Cursor, depth: number): Record<string, unknown> {
  cursor.index += 1
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  skipWhitespace(cursor)
  if (cursor.text[cursor.index] === "}") {
    cursor.index += 1
    return { ...result }
  }
  for (;;) {
    skipWhitespace(cursor)
    if (cursor.text[cursor.index] !== '"') fail(cursor, "expected a quoted object key")
    const keyOffset = cursor.index
    const key = parseString(cursor)
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      cursor.index = keyOffset
      fail(cursor, `duplicate key ${JSON.stringify(key)}`)
    }
    skipWhitespace(cursor)
    if (cursor.text[cursor.index] !== ":") fail(cursor, "expected ':' after object key")
    cursor.index += 1
    result[key] = parseValue(cursor, depth + 1)
    skipWhitespace(cursor)
    const next = cursor.text[cursor.index]
    if (next === ",") {
      cursor.index += 1
      continue
    }
    if (next === "}") {
      cursor.index += 1
      // Spread onto a normal prototype so downstream consumers behave predictably.
      return { ...result }
    }
    fail(cursor, "expected ',' or '}' in object")
  }
}

function parseArray(cursor: Cursor, depth: number): unknown[] {
  cursor.index += 1
  const result: unknown[] = []
  skipWhitespace(cursor)
  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1
    return result
  }
  for (;;) {
    result.push(parseValue(cursor, depth + 1))
    skipWhitespace(cursor)
    const next = cursor.text[cursor.index]
    if (next === ",") {
      cursor.index += 1
      continue
    }
    if (next === "]") {
      cursor.index += 1
      return result
    }
    fail(cursor, "expected ',' or ']' in array")
  }
}

function parseString(cursor: Cursor): string {
  cursor.index += 1
  let out = ""
  for (;;) {
    const char = cursor.text[cursor.index]
    if (char === undefined) fail(cursor, "unterminated string")
    if (char === '"') {
      cursor.index += 1
      return out
    }
    if (char === "\\") {
      const escape = cursor.text[cursor.index + 1]
      cursor.index += 2
      switch (escape) {
        case '"':
          out += '"'
          break
        case "\\":
          out += "\\"
          break
        case "/":
          out += "/"
          break
        case "b":
          out += "\b"
          break
        case "f":
          out += "\f"
          break
        case "n":
          out += "\n"
          break
        case "r":
          out += "\r"
          break
        case "t":
          out += "\t"
          break
        case "u": {
          const hex = cursor.text.slice(cursor.index, cursor.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(cursor, "invalid \\u escape")
          out += String.fromCharCode(Number.parseInt(hex, 16))
          cursor.index += 4
          break
        }
        default:
          cursor.index -= 2
          fail(cursor, "invalid escape sequence")
      }
      continue
    }
    // RFC 8259 forbids raw control characters inside strings.
    if (char < " ") fail(cursor, "raw control character in string")
    out += char
    cursor.index += 1
  }
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/

function parseNumber(cursor: Cursor): number {
  const match = NUMBER_PATTERN.exec(cursor.text.slice(cursor.index))
  if (!match) fail(cursor, "invalid number")
  cursor.index += match[0].length
  const value = Number(match[0])
  if (!Number.isFinite(value)) fail(cursor, "number is not finite")
  return value
}

/** Parse JSON, rejecting duplicate object keys, a BOM, and trailing content. */
export function parseJsonStrict(text: string): JsonParseResult {
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, error: "file starts with a byte-order mark", offset: 0 }
  }
  const cursor: Cursor = { text, index: 0 }
  try {
    const value = parseValue(cursor, 0)
    skipWhitespace(cursor)
    if (cursor.index !== text.length) {
      return { ok: false, error: "unexpected trailing content", offset: cursor.index }
    }
    return { ok: true, value }
  } catch (error) {
    if (error instanceof JsonError) return { ok: false, error: error.message, offset: error.offset }
    throw error
  }
}

/**
 * Deterministic JSON serialisation: keys sorted, two-space indent, trailing
 * newline. Used everywhere a document's bytes must be reproducible.
 */
export function stringifyJsonCanonical(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    const out: Record<string, unknown> = {}
    for (const [key, entry] of entries) out[key] = sortKeysDeep(entry)
    return out
  }
  return value
}
