/**
 * config_object.title is varchar(255) and config_object.description /
 * config_object.search_text are MySQL TEXT columns capped at 65,535 bytes.
 * Vitess/PlanetScale runs in strict SQL mode, so an oversized derived
 * projection fails the whole insert/update with errno 1406 ("Data too long
 * for column") instead of truncating (Sentry DEN-API-Z / DEN-API-1K).
 *
 * Derived projections exist for listing and search only; the untruncated
 * source of truth lives in config_object_version.raw_source_text
 * (MEDIUMTEXT), so clamping here loses nothing.
 */
export const PROJECTION_TITLE_MAX_CHARS = 255
export const PROJECTION_TEXT_MAX_BYTES = 60_000

/** Truncate to at most maxBytes of UTF-8 without splitting a code point. */
export function clampUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let bytes = 0
  let end = 0
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8")
    if (bytes + codePointBytes > maxBytes) break
    bytes += codePointBytes
    end += codePoint.length
  }
  return value.slice(0, end)
}

/** Truncate to at most maxCodePoints without splitting a surrogate pair. */
export function clampCodePoints(value: string, maxCodePoints: number): string {
  if (value.length <= maxCodePoints) return value
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maxCodePoints) break
    count += 1
    end += codePoint.length
  }
  return value.slice(0, end)
}
