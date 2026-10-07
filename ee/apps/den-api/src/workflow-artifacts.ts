import { createHash } from "node:crypto"
import type { ArtifactFreshness } from "@openwork/types/workflows"

export const WORKFLOW_MARKDOWN_RENDERER_VERSION = "codemode-markdown-v1" as const

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? "null" : encoded
}

export function canonicalArtifactJson(value: unknown): string {
  return canonical(value)
}

export function artifactDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`
}

export function optionalArtifactDigest(value: unknown): string | null {
  return value === undefined || value === null ? null : artifactDigest(value)
}

export function workflowArtifactSource(trigger: "scheduled" | "recovery" | "manual" | null): "scheduled" | "manual" {
  return trigger && trigger !== "manual" ? "scheduled" : "manual"
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function cell(value: unknown): string {
  const rendered = value === null ? "null" : typeof value === "string" ? value : String(value)
  return escapeHtml(rendered)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "\\n")
}

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

export function renderWorkflowMarkdown(value: unknown): string {
  if (typeof value === "string") return escapeHtml(value)

  if (isRecord(value) && Object.values(value).every(isScalar)) {
    return table(["Key", "Value"], Object.keys(value).sort().map((key) => [key, value[key]]))
  }

  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    const keys = Object.keys(value[0] ?? {}).sort()
    const homogeneous = value.every((entry) => {
      const entryKeys = Object.keys(entry).sort()
      return entryKeys.length === keys.length
        && entryKeys.every((key, index) => key === keys[index])
        && Object.values(entry).every(isScalar)
    })
    if (homogeneous) return table(keys, value.map((entry) => keys.map((key) => entry[key])))
  }

  return `\`\`\`json\n${canonical(value)}\n\`\`\``
}

/** The Workflow Artifact contract's limit for a needs_attention reason (@openwork/types/workflows). */
export const ARTIFACT_FRESHNESS_REASON_MAX_LENGTH = 2_000

/**
 * A failed run's error message can be any length, but the artifact contract
 * caps the reason. An over-long reason fails the MCP output schema, so the
 * whole artifact, including its last good snapshot, would not open.
 */
function freshnessReason(failureReason: string | null | undefined): string {
  const reason = failureReason?.trim() || "The latest refresh failed."
  if (reason.length <= ARTIFACT_FRESHNESS_REASON_MAX_LENGTH) return reason
  return `${reason.slice(0, ARTIFACT_FRESHNESS_REASON_MAX_LENGTH - 1).trimEnd()}…`
}

export function artifactFreshness(input: {
  latestFinishedAt: Date | null
  latestStatus: "succeeded" | "failed" | null
  latestSuccessfulFinishedAt: Date | null
  latestSuccessfulReceiptId: string | null
  maxAgeMs: number
  now?: Date
  failureReason?: string | null
}): ArtifactFreshness {
  const now = input.now ?? new Date()
  if (!input.latestFinishedAt || !input.latestStatus) return { state: "never_run" }
  const successfulAgeMs = input.latestSuccessfulFinishedAt
    ? Math.max(0, now.getTime() - input.latestSuccessfulFinishedAt.getTime())
    : null
  if (input.latestStatus === "failed") {
    return {
      state: "needs_attention",
      ageMs: successfulAgeMs,
      lastSuccessfulReceiptId: input.latestSuccessfulReceiptId,
      reason: freshnessReason(input.failureReason),
    }
  }
  const ageMs = Math.max(0, now.getTime() - input.latestFinishedAt.getTime())
  return ageMs > input.maxAgeMs
    ? { state: "stale", ageMs, maxAgeMs: input.maxAgeMs }
    : { state: "fresh", ageMs }
}
