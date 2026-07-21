import { describe, expect, test } from "bun:test"
import {
  normalizeToken,
  parseQuery,
  rankCapabilities,
  rerankCapabilityMatches,
  tokenizeText,
  type CapabilityCandidate,
} from "../src/mcp/ranking.js"
import type { CapabilityMatch } from "../src/mcp/search.js"

type CurrentCapabilityMatch = CapabilityMatch & {
  argumentsSchema?: unknown
  schemaDigest?: string
  invocation?: { argumentsField: "body" }
  kind?: string
  status?: string
  connectionStatus?: { action: { label: string } }
  mcpRequirements?: { serverName: string; state: string }[]
}

function candidate(input: {
  name: string
  searchName?: string
  summary: string
  keywords?: string[]
  method?: string
}): CapabilityCandidate {
  return {
    match: {
      name: input.name,
      method: input.method ?? "GET",
      path: "/v1/example",
      score: 0,
      summary: input.summary,
      pathParams: [],
      queryParams: [],
      hasBody: input.name.startsWith("post"),
    },
    searchText: {
      name: input.searchName ?? input.name,
      summary: input.summary,
      keywords: input.keywords,
    },
  }
}

const corpus: CapabilityCandidate[] = [
  candidate({ name: "postMemory", summary: "Save a memory for the current user.", keywords: ["Memory"] }),
  candidate({ name: "getMemorySearch", summary: "Search memories by semantic text.", keywords: ["Memory"] }),
  candidate({ name: "getWorkers", summary: "List hosted workers.", keywords: ["Workers"] }),
  candidate({ name: "postWorkers", summary: "Create a hosted worker.", keywords: ["Workers"] }),
  candidate({
    name: "marketplace:memory-keeper",
    searchName: "Memory keeper",
    summary: "A skill for remembering customer facts.",
    keywords: ["skill"],
  }),
  candidate({
    name: "mcp:notion:createPage",
    searchName: "Notion createPage",
    summary: "Create a page in Notion.",
    keywords: ["Notion"],
    method: "MCP",
  }),
  candidate({
    name: "skill:incident-response",
    searchName: "Incident response playbook",
    summary: "Guide responders through a production outage.",
    keywords: ["skill", "playbook"],
    method: "SKILL",
  }),
  candidate({
    name: "admin:listOrganizations",
    searchName: "list organizations",
    summary: "List organizations for platform support.",
    keywords: ["admin", "platform"],
    method: "MCP",
  }),
]

describe("capability lexical ranking", () => {
  test("tokenizes camelCase and normalizes conservative stems", () => {
    expect(tokenizeText("postMemory")).toEqual(["post", "memory"])
    expect(tokenizeText("mcp:conn:notion-search")).toEqual(["mcp", "conn", "notion", "search"])
    expect(normalizeToken("workers")).toBe("worker")
    expect(normalizeToken("memories")).toBe("memory")
    expect(normalizeToken("created")).toBe("creat")
    expect(normalizeToken("setting")).toBe("set")
    expect(normalizeToken("analysis")).toBe("analysis")
  })

  test("removes stopwords, deduplicates concepts, and expands synonyms", () => {
    expect(parseQuery("to the a")).toEqual([])
    const concepts = parseQuery("please save save a memory")
    expect(concepts.map((concept) => concept.original)).toEqual(["sav", "memory"])
    expect(concepts[0]?.terms).toContainEqual({ token: "post", factor: 0.7 })
  })

  test("closes common capability vocabulary gaps", () => {
    expect(rankCapabilities("save a memory", corpus)[0]?.name).toBe("postMemory")
    expect(rankCapabilities("search my memories", corpus)[0]?.name).toBe("getMemorySearch")
    expect(rankCapabilities("store a note", corpus)[0]?.name).toBe("postMemory")
    expect(rankCapabilities("production outage playbook", corpus)[0]?.name).toBe("skill:incident-response")
    expect(rankCapabilities("platform organizations", corpus)[0]?.name).toBe("admin:listOrganizations")
  })

  test("uses coverage and adjacency to separate list from create", () => {
    const matches = rankCapabilities("list workers", corpus)
    expect(matches[0]?.name).toBe("getWorkers")
    expect(matches.findIndex((match) => match.name === "getWorkers")).toBeLessThan(
      matches.findIndex((match) => match.name === "postWorkers"),
    )
  })

  test("preserves current contracts while globally reranking sources", () => {
    const bodySchema = { type: "object", required: ["email"] }
    const argumentsSchema = { type: "object", properties: { channel: { type: "string" } } }
    const matches: CurrentCapabilityMatch[] = [
      {
        name: "postInvitations",
        method: "POST",
        path: "/v1/invitations",
        score: 2,
        summary: "Invite a member to the organization.",
        pathParams: [],
        queryParams: [],
        hasBody: true,
        bodySchema,
      },
      {
        name: "mcp:slack:sendMessage",
        method: "MCP",
        path: "https://slack.example/mcp",
        score: 7,
        summary: "Send a Slack channel message.",
        pathParams: [],
        queryParams: [],
        hasBody: true,
        argumentsSchema,
        schemaDigest: `sha256:${"a".repeat(64)}`,
        invocation: { argumentsField: "body" },
      },
      {
        name: "marketplace:incident-response",
        method: "PLUGIN",
        path: "PLUGIN.md",
        score: 5,
        summary: "Install the incident response playbook.",
        pathParams: [],
        queryParams: [],
        hasBody: false,
        mcpRequirements: [{ serverName: "Slack", state: "needs_signin" }],
      },
    ]

    expect(rerankCapabilityMatches("invite a teammate", matches)[0]).toEqual(expect.objectContaining({
      name: "postInvitations",
      bodySchema,
    }))
    expect(rerankCapabilityMatches("send slack message", matches)[0]).toEqual(expect.objectContaining({
      name: "mcp:slack:sendMessage",
      argumentsSchema,
      invocation: { argumentsField: "body" },
    }))
    expect(rerankCapabilityMatches("incident playbook", matches)[0]).toEqual(expect.objectContaining({
      name: "marketplace:incident-response",
      mcpRequirements: [{ serverName: "Slack", state: "needs_signin" }],
    }))
  })

  test("keeps actionable connection status ahead of ordinary matches", () => {
    const status: CurrentCapabilityMatch = {
      name: "mcp:linear:*",
      method: "MCP",
      path: "https://linear.example/mcp",
      score: 1,
      summary: "Linear needs to be connected.",
      pathParams: [],
      queryParams: [],
      hasBody: false,
      kind: "connection_status",
      status: "needs_connection",
      connectionStatus: { action: { label: "Connect Linear" } },
    }
    const ordinary: CurrentCapabilityMatch = {
      name: "mcp:notion:search",
      method: "MCP",
      path: "https://notion.example/mcp",
      score: 20,
      summary: "Search Notion for Linear project notes.",
      pathParams: [],
      queryParams: [],
      hasBody: true,
    }
    expect(rerankCapabilityMatches("linear", [ordinary, status])[0]).toEqual(expect.objectContaining({
      name: "mcp:linear:*",
      connectionStatus: { action: { label: "Connect Linear" } },
    }))
  })

  test("returns bounded sorted integer scores", () => {
    const matches = rankCapabilities("memory", corpus, { limit: 100 })
    expect(matches.length).toBeLessThanOrEqual(20)
    for (let index = 0; index < matches.length; index += 1) {
      const score = matches[index]?.score ?? 0
      expect(Number.isInteger(score)).toBe(true)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(100)
      if (index > 0) expect(score).toBeLessThanOrEqual(matches[index - 1]?.score ?? 100)
    }
  })
})
