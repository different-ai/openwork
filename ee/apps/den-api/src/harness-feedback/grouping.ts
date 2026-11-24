import { createHash } from "node:crypto"
import { harnessFeedbackCategoryLabel, type HarnessFeedbackCategory, type HarnessFeedbackEvidence } from "./classifier.js"

type GroupInput = Pick<HarnessFeedbackEvidence, "surface" | "tool" | "errorCode"> & { category: HarnessFeedbackCategory }

const surfaceLabels: Record<GroupInput["surface"], string> = {
  tool: "tool", instructions: "instructions", skill: "skill", connector: "connection", environment: "environment", other: "other",
}

export function harnessFeedbackSurfaceLabel(surface: GroupInput["surface"]) {
  const label = surfaceLabels[surface]
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function normalize(value: string | null) {
  return value?.trim().toLowerCase() ?? ""
}

export function harnessFeedbackGroupKey({ category, surface, tool, errorCode }: GroupInput) {
  const normalizedTool = normalize(tool)
  const hash = createHash("sha256").update(JSON.stringify([category, surface, normalizedTool, normalize(errorCode)])).digest("hex")
  const subject = normalizedTool ? `${surfaceLabels[surface]}: ${normalizedTool}` : surfaceLabels[surface]
  return {
    fingerprint: `v1:${hash}`,
    title: `${harnessFeedbackCategoryLabel(category)} (${subject})`,
    tool: normalizedTool || null,
  }
}
