export type ToolErrorAttribution = {
  label: string
  confidence: "Confirmed" | "Inferred"
  description: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseErrorRecord(errorText: string): Record<string, unknown> | null {
  const trimmed = errorText.trim()
  const jsonStart = trimmed.indexOf("{")
  const jsonEnd = trimmed.lastIndexOf("}")
  const candidates = [
    trimmed,
    ...(jsonStart > 0 ? [trimmed.slice(jsonStart)] : []),
    ...(jsonStart >= 0 && jsonEnd > jsonStart ? [trimmed.slice(jsonStart, jsonEnd + 1)] : []),
  ]

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed
    } catch {
      // The engine may wrap the MCP JSON in a plain error message.
    }
  }
  return null
}

function diagnosticFromError(errorText: string): Record<string, unknown> | null {
  const parsed = parseErrorRecord(errorText)
  if (!parsed) return null
  return isRecord(parsed.diagnostic) ? parsed.diagnostic : parsed
}

function stringValue(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function confirmed(label: string, description: string): ToolErrorAttribution {
  return { label, confidence: "Confirmed", description }
}

export function attributeChatToolError(errorText: string): ToolErrorAttribution | null {
  const diagnostic = diagnosticFromError(errorText)
  const code = stringValue(diagnostic, "code")
  const category = stringValue(diagnostic, "category")
  const phase = stringValue(diagnostic, "phase")
  const httpStatus = numberValue(diagnostic, "httpStatus")
  const providerStatus = numberValue(diagnostic, "providerStatus")
  const providerCode = stringValue(diagnostic, "providerCode")

  if (
    errorText.includes("OpenWork stopped waiting after")
    || /The capability call exceeded \d+(?:\.\d+)?s\b/.test(errorText)
    || code === "MCP_LIFECYCLE_DEADLINE"
    || code === "MCP_REQUEST_TIMEOUT"
    || category === "lifecycle_deadline"
  ) {
    return confirmed(
      "OpenWork timeout",
      "OpenWork created this deadline. The external operation may still have completed, so verify its state before retrying.",
    )
  }

  if (
    category === "security_blocked"
    || code === "MCP_URL_BLOCKED"
    || code === "MCP_FETCH_FORBIDDEN_PORT"
  ) {
    return confirmed("Blocked by OpenWork", "OpenWork blocked the request before it was sent.")
  }

  if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
    return confirmed(
      `Remote MCP · HTTP ${httpStatus}`,
      `The remote MCP returned HTTP ${httpStatus}.`,
    )
  }

  if (
    phase?.startsWith("PROVIDER_")
    || category?.startsWith("provider_")
    || providerStatus !== undefined
    || providerCode !== undefined
  ) {
    return confirmed(
      "Provider error",
      providerStatus === undefined
        ? "The remote MCP responded, but the downstream provider or tool rejected the operation."
        : `The remote MCP responded, but the downstream provider returned status ${providerStatus}.`,
    )
  }

  if (/\b(?:timed out|timeout|deadline exceeded)\b/i.test(errorText)) {
    return {
      label: "Timeout · source unclear",
      confidence: "Inferred",
      description: "A timeout was reported, but the client did not receive structured evidence identifying which boundary created it.",
    }
  }

  return null
}
