import { describe, expect, test } from "bun:test"
import { parseWebSearchResults } from "../src/lib/websearch-results"

describe("parseWebSearchResults", () => {
  test("keeps OpenCode v1 Title/URL/Highlights blocks", () => {
    const output = [
      "Title: Bun releases",
      "URL: https://example.com/bun",
      "Highlights: Latest is 1.4.4",
      "---",
      "Title: N/A",
      "URL: https://example.org/other",
      "Highlights: Another hit",
    ].join("\n")

    expect(parseWebSearchResults(output)).toEqual([
      {
        title: "Bun releases",
        url: "https://example.com/bun",
        description: "Latest is 1.4.4",
      },
      {
        title: "example.org",
        url: "https://example.org/other",
        description: "Another hit",
      },
    ])
  })

  test("parses OpenCode v2 markdown headings with links", () => {
    const output = [
      "## [Example title](https://example.com/page)",
      "Published: 2026-10-30T00:00:00.000Z",
      "",
      "Excerpt text about the page.",
      "",
      "## [Another title](https://example.org/other)",
      "",
      "Second excerpt.",
    ].join("\n")

    expect(parseWebSearchResults(output)).toEqual([
      {
        title: "Example title",
        url: "https://example.com/page",
        description: "Excerpt text about the page.",
      },
      {
        title: "Another title",
        url: "https://example.org/other",
        description: "Second excerpt.",
      },
    ])
  })

  test("returns empty for the v2 no-results placeholder", () => {
    expect(
      parseWebSearchResults("No search results found. Please try a different query."),
    ).toEqual([])
  })

  test("does not claim v1 empty when only v2 results are present", () => {
    // Repro for #6874: card showed "Web search (No results)" because the
    // parser only understood v1 URL: lines.
    const output = [
      "## [Speed limits in Germany](https://example.com/de-speed)",
      "Published: 2026-01-01T00:00:00.000Z",
      "",
      "Autobahns often have no general limit; many roads are 100 km/h.",
    ].join("\n")

    const results = parseWebSearchResults(output)
    expect(results).toHaveLength(1)
    expect(results[0]?.url).toBe("https://example.com/de-speed")
    expect(results[0]?.title).toBe("Speed limits in Germany")
  })
})
