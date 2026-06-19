"use client"

import { Tool } from "@/components/ui/tool"
import type { ApplyPatchToolPart } from "@/lib/build-in-tools"

interface ApplyPatchToolProps {
  part: ApplyPatchToolPart
}

function getApplyPatchToolTitle(part: ApplyPatchToolPart): string | null {
  if (part.state === "output-error") {
    return "Apply patch attempted"
  }

  if (part.state !== "output-available") {
    return null
  }

  return "Apply patch"
}

export function ApplyPatchTool({ part }: ApplyPatchToolProps) {
  return (
    <Tool toolPart={part} title={getApplyPatchToolTitle(part) ?? undefined} />
  )
}
