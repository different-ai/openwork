"use client"

import { SquareTerminalIcon } from "lucide-react"
import {
  CollapsibleTool,
  CollapsibleToolContent,
  CollapsibleToolStep,
  CollapsibleToolTrigger,
} from "@/components/tools/collapsible-tool"
import type { BashToolPart } from "@/lib/build-in-tools"

interface BashToolProps {
  part: BashToolPart
}

export function BashTool({ part }: BashToolProps) {
  return (
    <CollapsibleTool>
      <CollapsibleToolStep className="flex flex-col gap-2">
        <CollapsibleToolTrigger leftIcon={<SquareTerminalIcon className="size-4" />}>
          <span className="flex gap-2">
            <span className="shrink-0">
              {part.input.description}
            </span>
            <span className="opacity-80 truncate grow">
              {part.input.command}
            </span>
          </span>
        </CollapsibleToolTrigger>
        <CollapsibleToolContent className="bg-muted rounded-lg p-2">
          <div className="flex flex-col gap-2 text-xs">
            <pre>$ {part.input.command}</pre>
            <pre className="opacity-80">{part.output}</pre>
          </div>
        </CollapsibleToolContent>
      </CollapsibleToolStep>
    </CollapsibleTool>
  )
}
