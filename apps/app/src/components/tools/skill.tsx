"use client"

import { CapabilityCallLine } from "@/components/chat/capability-call-line"
import type { SkillToolPart } from "@/lib/build-in-tools"

export function SkillTool({ part }: { part: SkillToolPart }) {
  return <CapabilityCallLine part={part} />
}
