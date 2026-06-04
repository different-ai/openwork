import * as React from "react"
import { Globe } from "lucide-react"
import {
  Source,
  SourceContent,
  SourceTrigger,
} from "@/components/ui/source"
import type { WebFetchToolPart } from "@/lib/build-in-tools"
import { cn } from "@/lib/utils"
import { Tool } from "@/components/ui/tool"

interface WebfetchToolProps {
  part: WebFetchToolPart
}

export function WebfetchTool({ part }: WebfetchToolProps) {
  if (part.state === "output-error") {
    return <Tool toolPart={part} />
  }

  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  return (
    <div className="flex gap-2">
      <WebfetchTrigger leftIcon={<Globe className="size-4" />}>
        Fetching
      </WebfetchTrigger>
      <Source href={part.input.url}>
        <SourceTrigger showFavicon />
        <SourceContent
          title={part.input.url}
        />
      </Source>
    </div>
  )
}

interface WebfetchTriggerProps {
  children: React.ReactNode
  className?: string
  leftIcon?: React.ReactNode
}

function WebfetchTrigger({
  children,
  className,
  leftIcon,
}: WebfetchTriggerProps) {
  return (
    <div
      className={cn(
        "group text-muted-foreground hover:text-foreground flex cursor-default items-center justify-start gap-1 text-start text-sm transition-colors",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {leftIcon && (
          <span className="relative inline-flex size-4 items-center justify-center">
            {leftIcon}
          </span>
        )}
        <span>{children}</span>
      </div>
    </div>
  )
}