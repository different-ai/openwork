import { describe, expect, test } from "bun:test"
import {
  buildZeroResultSuggestions,
  normalizeToken,
  parseQuery,
  rankCapabilities,
  tokenizeText,
  type CapabilityCandidate,
} from "../src/mcp/ranking.js"

function candidate(input: {
  name: string
  source: "rest" | "external_mcp" | "marketplace"
  searchName?: string
  summary: string
  keywords?: string[]
  status?: "needs_connection"
}): CapabilityCandidate {
  return {
    match: {
      name: input.name,
      method: input.source === "rest" ? "GET" : "MCP",
      path: input.source === "rest" ? "/v1/example" : "https://example.test/mcp",
      summary: input.summary,
      pathParams: [],
      queryParams: [],
      hasBody: input.name.startsWith("post") || input.source === "external_mcp",
      source: input.source,
      status: input.status,
      hint: input.status === "needs_connection" ? "Connect this account, then search again." : undefined,
    },
    searchText: {
      name: input.searchName ?? input.name,
      summary: input.summary,
      keywords: input.keywords,
    },
  }
}

const corpus: CapabilityCandidate[] = [
  candidate({
    name: "postMemory",
    source: "rest",
    summary: "Save a memory for the current user.",
    keywords: ["Memory"],
  }),
  candidate({
    name: "getMemorySearch",
    source: "rest",
    summary: "Search memories by semantic text.",
    keywords: ["Memory"],
  }),
  candidate({
    name: "getWorkers",
    source: "rest",
    summary: "List hosted workers.",
    keywords: ["Workers"],
  }),
  candidate({
    name: "postWorkers",
    source: "rest",
    summary: "Create a hosted worker.",
    keywords: ["Workers"],
  }),
  candidate({
    name: "skill:memory-keeper",
    source: "marketplace",
    searchName: "Memory keeper",
    summary: "A skill for remembering customer facts.",
    keywords: ["skill"],
  }),
  candidate({
    name: "mcp:linear:*",
    source: "external_mcp",
    searchName: "Linear",
    summary: "Linear is available, but you have not connected your account.",
    keywords: ["Linear"],
    status: "needs_connection",
  }),
  candidate({
    name: "mcp:notion:createPage",
    source: "external_mcp",
    searchName: "Notion createPage",
    summary: "Create a page in Notion.",
    keywords: ["Notion"],
  }),
]

describe("capability lexical ranking", () => {
  test("tokenizes camelCase and normalizes conservative stems", () => {
    expect(tokenizeText("postMemory")).toEqual(["post", "memory"])
    expect(tokenizeText("mcp:conn:notion-search")).toEqual(["mcp", "conn", "notion", "search"])

    expect(normalizeToken("workers")).toBe("worker")
    expect(normalizeToken("memories")).toBe("memory")
    expect(normalizeToken("create")).toBe("creat")
    expect(normalizeToken("creates")).toBe("creat")
    expect(normalizeToken("created")).toBe("creat")
    expect(normalizeToken("creating")).toBe("creat")
    expect(normalizeToken("setting")).toBe("set")
    expect(normalizeToken("status")).toBe("status")
    expect(normalizeToken("access")).toBe("access")
    expect(normalizeToken("analysis")).toBe("analysis")
    expect(normalizeToken("v1")).toBe("v1")
  })

  test("removes stopwords, dedupes concepts, and expands synonyms", () => {
    expect(parseQuery("to the a")).toEqual([])

    const concepts = parseQuery("please save save a memory")
    expect(concepts.map((concept) => concept.original)).toEqual(["sav", "memory"])
    const save = concepts[0]
    expect(save?.terms.some((term) => term.token === "post" && term.factor < 1)).toBe(true)
  })

  test("ranks vocabulary mismatch and direct search cases", () => {
    expect(rankCapabilities("save a memory", corpus, { limit: 5 })[0]?.name).toBe("postMemory")
    expect(rankCapabilities("search my memories", corpus, { limit: 5 })[0]?.name).toBe("getMemorySearch")
    expect(rankCapabilities("store a note", corpus, { limit: 5 })[0]?.name).toBe("postMemory")
  })

  test("coverage and adjacency beat single-field stacking", () => {
    const matches = rankCapabilities("list workers", corpus, { limit: 5 })
    expect(matches[0]?.name).toBe("getWorkers")
    expect(matches.findIndex((match) => match.name === "getWorkers")).toBeLessThan(
      matches.findIndex((match) => match.name === "postWorkers"),
    )
  })

  test("cross-source ranking keeps needs_connection rows and source metadata", () => {
    const linear = rankCapabilities("linear", corpus, { limit: 5 })[0]
    expect(linear?.name).toBe("mcp:linear:*")
    expect(linear?.source).toBe("external_mcp")
    expect(linear?.status).toBe("needs_connection")
    expect(linear?.hint).toContain("Connect")

    const notion = rankCapabilities("notion page", corpus, { limit: 5 })[0]
    expect(notion?.name).toBe("mcp:notion:createPage")
    expect(notion?.source).toBe("external_mcp")
  })

  test("returns bounded sorted integer scores", () => {
    const matches = rankCapabilities("memory", corpus, { limit: 100 })
    expect(matches.length).toBeLessThanOrEqual(20)
    for (let index = 0; index < matches.length; index += 1) {
      const score = matches[index]?.score ?? 0
      expect(Number.isInteger(score)).toBe(true)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(100)
      if (index > 0) {
        expect(score).toBeLessThanOrEqual(matches[index - 1]?.score ?? 100)
      }
    }
  })

  test("suggests near-miss names by shared prefix", () => {
    expect(buildZeroResultSuggestions("memor", corpus)).toContain("postMemory")
    expect(buildZeroResultSuggestions("zzzz", corpus)).toEqual([])
  })
})
