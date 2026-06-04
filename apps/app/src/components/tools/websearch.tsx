"use client"

import { Search } from "lucide-react"
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from "@/components/ui/chain-of-thought"
import {
  Source,
  SourceContent,
  SourceTrigger,
} from "@/components/ui/source"
import type { WebSearchToolPart } from "@/lib/build-in-tools"
import { Tool } from "@/components/ui/tool"
import { parseWebSearchResults } from "@/lib/websearch-results"

interface WebsearchToolProps {
  part: WebSearchToolPart
}

export function WebsearchTool({ part }: WebsearchToolProps) {
  if (part.state === "output-error") {
    return <Tool toolPart={part} />
  }

  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  const results = parseWebSearchResults(part.output)

  return (
    <ChainOfThought>
      <ChainOfThoughtStep>
        <ChainOfThoughtTrigger leftIcon={<Search className="size-4" />}>
          {results.length > 0 ? `Searching for "${part.input.query}"` : "Web search (No results)"}
        </ChainOfThoughtTrigger>
        <ChainOfThoughtContent>
          <div className="flex flex-wrap items-center gap-2">
            {results.map((result) => (
              <Source href={result.url} key={result.url}>
                <SourceTrigger showFavicon />
                <SourceContent
                  title={result.title}
                  description={result.description}
                />
              </Source>
            ))}
          </div>
        </ChainOfThoughtContent>
      </ChainOfThoughtStep>
    </ChainOfThought>
  )
}