import type { InferenceOrganizationMetadata } from "@openwork/types/den/inference"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readInferenceMetadata(metadata: Record<string, unknown> | null): InferenceOrganizationMetadata | null {
  if (!isRecord(metadata?.inference)) {
    return null
  }

  const inference = metadata.inference
  if (inference.enabled !== true || inference.tier !== "tier1" && inference.tier !== "tier2") {
    return null
  }

  return { enabled: true, tier: inference.tier }
}

export function setInferenceMetadata(metadata: Record<string, unknown> | null, inference: InferenceOrganizationMetadata | null) {
  const next = { ...(metadata ?? {}) }
  if (inference) {
    next.inference = { ...(isRecord(next.inference) ? next.inference : {}), ...inference }
  } else if (isRecord(next.inference)) {
    const remaining = { ...next.inference }
    delete remaining.enabled
    delete remaining.tier
    if (Object.keys(remaining).length > 0) {
      next.inference = remaining
    } else {
      delete next.inference
    }
  }
  return next
}
