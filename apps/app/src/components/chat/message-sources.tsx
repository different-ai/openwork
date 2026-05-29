"use memo";

import * as React from "react"
import type { UIMessage } from "ai"
import {
  Source,
  SourceContent,
  SourceTrigger,
} from "@/components/ui/source"
import { isWebFetchToolPart, isWebSearchToolPart } from "@/lib/build-in-tools"
import { parseWebSearchResults } from "@/lib/websearch-results"

type MessageSourceItem = {
  key: string
  href: string
  title: string
  description?: string
  showFavicon: boolean
}

function getMessageSourceItems(messages: UIMessage[]): MessageSourceItem[] {
  const seen = new Set<string>()
  const items: MessageSourceItem[] = []

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "source-url") {
        if (seen.has(part.url)) {
          continue
        }

        seen.add(part.url)
        items.push({
          key: part.sourceId,
          href: part.url,
          title: part.title ?? part.url,
          showFavicon: true,
        })
        continue
      }

      if (part.type === "source-document") {
        if (seen.has(part.sourceId)) {
          continue
        }

        seen.add(part.sourceId)
        items.push({
          key: part.sourceId,
          href: part.filename ?? part.title,
          title: part.title,
          showFavicon: false,
        })
        continue
      }

      if (part.type === "dynamic-tool" && isWebFetchToolPart(part) && part.state === "output-available") {
        const url = part.input.url
        if (seen.has(url)) {
          continue
        }

        seen.add(url)
        items.push({
          key: part.toolCallId,
          href: url,
          title: url,
          showFavicon: true,
        })
        continue
      }

      if (part.type === "dynamic-tool" && isWebSearchToolPart(part) && part.state === "output-available") {
        for (const result of parseWebSearchResults(part.output)) {
          if (seen.has(result.url)) {
            continue
          }

          seen.add(result.url)
          items.push({
            key: `${part.toolCallId}-${result.url}`,
            href: result.url,
            title: result.title,
            description: result.description,
            showFavicon: true,
          })
        }
      }
    }
  }

  return items
}

interface MessageSourcesProps {
  messages: UIMessage[]
}

export const MessageSources = React.memo(({ messages }: MessageSourcesProps) => {
  const sources = React.useMemo(() => getMessageSourceItems(messages), [messages])

  if (sources.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source) => (
        <Source href={source.href} key={source.key}>
          <SourceTrigger showFavicon={source.showFavicon} />
          <SourceContent
            title={source.title}
            description={source.description}
          />
        </Source>
      ))}
    </div>
  )
})

MessageSources.displayName = "MessageSources"
