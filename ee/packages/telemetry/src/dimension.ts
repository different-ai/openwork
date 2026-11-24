import { createHash } from "node:crypto"

const VALUE_MAX_LENGTH = 128
const HASH_PREFIX_LENGTH = 10
const FALLBACK_SLUG = "dimension"

function labelSlug(label: string): string {
  const folded = label.trim().toLowerCase().normalize("NFKD")
  let out = ""
  let pendingHyphen = false
  for (const ch of folded) {
    if (ch >= "a" && ch <= "z" || ch >= "0" && ch <= "9") {
      if (pendingHyphen && out.length > 0) out += "-"
      pendingHyphen = false
      out += ch
    } else if (ch >= "\u0300" && ch <= "\u036f") {
    } else {
      pendingHyphen = true
    }
  }
  return out.length > 0 ? out : FALLBACK_SLUG
}

/**
 * Derive a stable dimension value from a (type, label) pair.
 *
 * The value is a bounded slug of the label plus a short content hash so that
 * the same label always maps to the same value, different labels collide
 * only with hash probability, and the result always satisfies the dimension
 * value contract (max 128 chars, safe character set).
 *
 * The exact derivation (hash input `type:label`, 10-hex prefix) is a wire
 * contract: values already stored in telemetry_session_dimension must keep
 * matching values derived for future events.
 */
export function deriveDimensionValue(type: string, label: string): string {
  const digest = createHash("sha256")
    .update(`${type}:${label.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, HASH_PREFIX_LENGTH)
  const suffix = `-${digest}`
  const budget = VALUE_MAX_LENGTH - suffix.length
  return `${labelSlug(label).slice(0, budget)}${suffix}`
}
