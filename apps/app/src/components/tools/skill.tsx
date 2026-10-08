"use client"

import { Tool } from "@/components/ui/tool"
import type { SkillToolPart } from "@/lib/build-in-tools"

interface SkillToolProps {
  part: SkillToolPart
}

function getSkillToolTitle(part: SkillToolPart): string | null {
  const name = part.input?.name?.trim() ?? ""

  if (part.state === "output-error") {
    return name ? `Couldn't use your ${name} skill` : "Couldn't use a skill"
  }

  if (part.state !== "output-available") {
    return null
  }

  return name ? `Using your ${name} skill` : "Using a skill"
}

export function SkillTool({ part }: SkillToolProps) {
  return <Tool toolPart={part} title={getSkillToolTitle(part) ?? undefined} />
}
