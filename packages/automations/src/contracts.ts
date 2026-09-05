import type { AutomationRevision } from "@openwork/types/automations"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Portable stable digest; persistence may additionally use a cryptographic digest.
 *
 * Callers must include `workspaceId` only when it is set: a pinned workspace is
 * behavior-changing, but records created before pinning existed must keep their
 * digests byte-identical.
 */
export function automationRevisionDigest(
  revision: Pick<AutomationRevision, "instructions" | "schedule" | "model" | "maximumRuntimeMs">
    & Partial<Pick<AutomationRevision, "action" | "executionTarget" | "workspaceId">>,
): string {
  const input = canonical(revision)
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ code, 0x85ebca6b)
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`
}

export interface AutomationOccurrenceIdentityInput {
  automationId: string
  scheduledFor: number | null
  nonce?: string
}

export function automationOccurrenceIdentity(input: AutomationOccurrenceIdentityInput): {
  occurrenceId: string
  idempotencyKey: string
} {
  if (input.scheduledFor === null && !input.nonce) throw new Error("A manual occurrence needs a nonce")
  const occurrence = input.scheduledFor === null ? `manual:${input.nonce}` : String(input.scheduledFor)
  const stable = [input.automationId, occurrence]
    .map(encodeURIComponent).join(":")
  return {
    occurrenceId: `automation-occurrence:${stable}`,
    idempotencyKey: `automation:${stable}`,
  }
}
