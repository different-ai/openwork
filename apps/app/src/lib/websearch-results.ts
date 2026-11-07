export interface WebSearchResult {
  title: string
  url: string
  description?: string
}

const TITLE_PATTERN = /^Title:\s*(.+)$/m
const URL_PATTERN = /^URL:\s*(https?:\/\/\S+)$/m
const HIGHLIGHTS_PATTERN = /(?:^|\n)Highlights:\s*([\s\S]*?)(?:\n\[\.\.\.\]|$)/

/** OpenCode v1 (Exa) blocks: Title / URL / Highlights, joined by ---. */
function parseV1WebSearchResults(output: string): WebSearchResult[] {
  return output.split(/\n---\n/).flatMap((block) => {
    const title = block.match(TITLE_PATTERN)?.[1]?.trim()
    const url = block.match(URL_PATTERN)?.[1]?.trim()
    const description = block.match(HIGHLIGHTS_PATTERN)?.[1]?.trim()

    if (!url) {
      return []
    }

    try {
      return [
        {
          title: title && title !== "N/A" ? title : new URL(url).hostname,
          url,
          description,
        },
      ]
    } catch {
      return []
    }
  })
}

/**
 * OpenCode v2 websearch text: markdown headings with an optional published
 * date and excerpt paragraph.
 *
 * ```
 * ## [Title](https://example.com/page)
 * Published: 2026-10-30T00:00:00.000Z
 *
 * Excerpt…
 * ```
 */
const V2_HEADING_PATTERN =
  /^##\s+(?:\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(.+))\s*$/gm

function parseV2WebSearchResults(output: string): WebSearchResult[] {
  const matches = [...output.matchAll(V2_HEADING_PATTERN)]
  if (matches.length === 0) {
    return []
  }

  const results: WebSearchResult[] = []

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const linkedTitle = match[1]?.trim()
    const linkedUrl = match[2]?.trim()
    const plainTitle = match[3]?.trim()
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? output.length) : output.length
    const body = output.slice(start, end).trim()

    let url = linkedUrl
    let title = linkedTitle || plainTitle || ""

    if (!url) {
      const bareUrl = body.match(/^(https?:\/\/\S+)/m)?.[1]?.trim()
      if (bareUrl) {
        url = bareUrl
      }
    }

    if (!url) {
      continue
    }

    const withoutPublished = body
      .replace(/^Published:\s*\S+\s*/i, "")
      .replace(/^https?:\/\/\S+\s*/m, "")
      .trim()
    const description = withoutPublished.length > 0 ? withoutPublished : undefined

    try {
      results.push({
        title: title && title !== "N/A" ? title : new URL(url).hostname,
        url,
        description,
      })
    } catch {
      // skip malformed URLs
    }
  }

  return results
}

export function parseWebSearchResults(output: string): WebSearchResult[] {
  const v1 = parseV1WebSearchResults(output)
  if (v1.length > 0) {
    return v1
  }
  return parseV2WebSearchResults(output)
}
