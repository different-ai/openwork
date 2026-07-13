import { createHash } from "node:crypto"
import type { SafeTraceDetail } from "../contracts/runtime.js"

const secretKeyPattern = /(authorization|token|secret|password|code|verifier|session|cookie)/i
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const tokenLikePattern = /\b(?:access|refresh|code|session)[-_][A-Za-z0-9._~+/=-]{8,}\b/gi

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function redactText(value: string, knownSecrets: readonly string[]): string {
  let redacted = value.replace(bearerPattern, "Bearer [REDACTED]").replace(tokenLikePattern, "[REDACTED]")
  for (const secret of knownSecrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]")
  }
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted
}

export function sanitizeTraceDetails(
  details: Readonly<Record<string, SafeTraceDetail>>,
  knownSecrets: readonly string[],
): Readonly<Record<string, SafeTraceDetail>> {
  const sanitized: Record<string, SafeTraceDetail> = {}
  for (const [key, value] of Object.entries(details)) {
    if (secretKeyPattern.test(key)) {
      sanitized[key] = "[REDACTED]"
      continue
    }
    if (typeof value === "string") {
      sanitized[key] = redactText(value, knownSecrets)
      continue
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => redactText(item, knownSecrets))
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}
