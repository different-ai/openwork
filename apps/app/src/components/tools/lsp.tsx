"use client"

import { Tool } from "@/components/ui/tool"
import type { LspInput, LspToolPart } from "@/lib/build-in-tools"
import { parseFilename, toolDisplayTitle } from "@/components/tools/path"

interface LspToolProps {
  part: LspToolPart
}

const LSP_OPERATION_LABELS: Record<LspInput["operation"], string> = {
  goToDefinition: "Go to definition",
  findReferences: "Find references",
  hover: "Hover",
  documentSymbol: "Document symbols",
  workspaceSymbol: "Workspace symbols",
  goToImplementation: "Go to implementation",
  prepareCallHierarchy: "Prepare call hierarchy",
  incomingCalls: "Incoming calls",
  outgoingCalls: "Outgoing calls",
}

function getLspToolTitle(part: LspToolPart): string | null {
  const filename = parseFilename(part.input.filePath)
  const operation = LSP_OPERATION_LABELS[part.input.operation]

  if (part.state === "output-error") {
    return `${operation} attempted in ${filename}`
  }

  if (part.state !== "output-available") {
    return null
  }

  return `${operation} in ${filename}`
}

function getLspToolDetail(part: LspToolPart): string | undefined {
  const line = part.input.line
  const character = part.input.character
  const query = part.input.query?.trim()

  const location = `L${line}:${character}`
  if (query) {
    return `${location} · ${query}`
  }

  return location
}

export function LspTool({ part }: LspToolProps) {
  return (
    <Tool
      toolPart={part}
      title={toolDisplayTitle(getLspToolTitle(part), getLspToolDetail(part))}
    />
  )
}
