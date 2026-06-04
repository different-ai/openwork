export interface WebSearchResult {
  title: string
  url: string
  description?: string
}

const TITLE_PATTERN = /^Title:\s*(.+)$/m
const URL_PATTERN = /^URL:\s*(https?:\/\/\S+)$/m
const HIGHLIGHTS_PATTERN = /(?:^|\n)Highlights:\s*([\s\S]*?)(?:\n\[\.\.\.\]|$)/

export function parseWebSearchResults(output: string): WebSearchResult[] {
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
