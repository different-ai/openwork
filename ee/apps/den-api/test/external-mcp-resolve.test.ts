import { describe, expect, test } from "bun:test"
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"
import {
  classifyResolveQuery,
  discoveryQualifiesAsMcp,
  matchPresetForQuery,
  normalizeQueryText,
  resolveCandidateUrls,
  suggestConnectionName,
} from "../src/capability-sources/external-mcp-resolve.js"
import { EXTERNAL_MCP_PRESETS } from "../src/capability-sources/external-mcp-presets.js"

describe("classifyResolveQuery", () => {
  test("classifies full URLs", () => {
    expect(classifyResolveQuery("https://mcp.vercel.com/mcp")).toEqual({ kind: "url", url: "https://mcp.vercel.com/mcp" })
    expect(classifyResolveQuery("  http://mcp.internal.example/mcp  ")).toEqual({ kind: "url", url: "http://mcp.internal.example/mcp" })
  })

  test("classifies bare hosts as domains", () => {
    expect(classifyResolveQuery("mcp.vercel.com")).toEqual({ kind: "domain", url: "https://mcp.vercel.com/" })
    expect(classifyResolveQuery("vercel.com/mcp")).toEqual({ kind: "domain", url: "https://vercel.com/mcp" })
  })

  test("classifies product names", () => {
    expect(classifyResolveQuery("vercel")).toEqual({ kind: "name", slug: "vercel" })
    expect(classifyResolveQuery("Google Drive")).toEqual({ kind: "name", slug: "googledrive" })
  })

  test("rejects URLs with credentials or fragments", () => {
    expect(classifyResolveQuery("https://user:pass@mcp.example.com/mcp").kind).toBe("invalid")
    expect(classifyResolveQuery("https://mcp.example.com/mcp#frag").kind).toBe("invalid")
    expect(classifyResolveQuery("ftp://mcp.example.com").kind).toBe("invalid")
  })

  test("rejects empty, oversized, and unparseable queries", () => {
    expect(classifyResolveQuery("   ").kind).toBe("invalid")
    expect(classifyResolveQuery("a".repeat(201)).kind).toBe("invalid")
    expect(classifyResolveQuery("not a domain. definitely").kind).toBe("invalid")
    expect(classifyResolveQuery("!!!").kind).toBe("invalid")
  })
})

describe("resolveCandidateUrls", () => {
  test("keeps an exact URL first and adds /mcp only for bare roots", () => {
    expect(resolveCandidateUrls({ kind: "url", url: "https://mcp.example.com/custom" }))
      .toEqual(["https://mcp.example.com/custom"])
    expect(resolveCandidateUrls({ kind: "url", url: "https://mcp.example.com/" }))
      .toEqual(["https://mcp.example.com/", "https://mcp.example.com/mcp"])
  })

  test("expands a bare apex domain with the mcp. host convention", () => {
    expect(resolveCandidateUrls({ kind: "domain", url: "https://vercel.com/" })).toEqual([
      "https://vercel.com/",
      "https://vercel.com/mcp",
      "https://mcp.vercel.com/mcp",
    ])
  })

  test("does not re-prefix hosts that already start with mcp.", () => {
    const candidates = resolveCandidateUrls({ kind: "domain", url: "https://mcp.vercel.com/" })
    expect(candidates).toEqual(["https://mcp.vercel.com/", "https://mcp.vercel.com/mcp"])
  })

  test("probes bounded well-known hosts for a bare name, including the .com root", () => {
    expect(resolveCandidateUrls({ kind: "name", slug: "vercel" })).toEqual([
      "https://mcp.vercel.com/mcp",
      "https://mcp.vercel.com/",
      "https://mcp.vercel.dev/mcp",
      "https://mcp.vercel.io/mcp",
      "https://mcp.vercel.ai/mcp",
    ])
  })

  test("never exceeds the candidate limit", () => {
    for (const classification of [
      { kind: "name" as const, slug: "vercel" },
      { kind: "domain" as const, url: "https://vercel.com/" },
      { kind: "url" as const, url: "https://mcp.example.com/" },
    ]) {
      expect(resolveCandidateUrls(classification).length).toBeLessThanOrEqual(5)
    }
  })
})

describe("matchPresetForQuery", () => {
  test("matches by id and display name, case- and punctuation-insensitively", () => {
    expect(matchPresetForQuery("notion", EXTERNAL_MCP_PRESETS)?.presetId).toBe("notion")
    expect(matchPresetForQuery("  Linear ", EXTERNAL_MCP_PRESETS)?.presetId).toBe("linear")
    expect(matchPresetForQuery("CONTEXT7", EXTERNAL_MCP_PRESETS)?.presetId).toBe("context7")
  })

  test("matches by preset URL host for URL and domain queries", () => {
    expect(matchPresetForQuery("https://mcp.notion.com/mcp", EXTERNAL_MCP_PRESETS)?.presetId).toBe("notion")
    expect(matchPresetForQuery("mcp.stripe.com", EXTERNAL_MCP_PRESETS)?.presetId).toBe("stripe")
  })

  test("returns null for unknown names", () => {
    expect(matchPresetForQuery("vercel", EXTERNAL_MCP_PRESETS)).toBeNull()
    expect(matchPresetForQuery("notio", EXTERNAL_MCP_PRESETS)).toBeNull()
  })
})

describe("suggestConnectionName", () => {
  test("strips service prefixes and capitalizes the product label", () => {
    expect(suggestConnectionName("https://mcp.vercel.com/mcp")).toBe("Vercel")
    expect(suggestConnectionName("https://www.example.io/")).toBe("Example")
    expect(suggestConnectionName("https://api.acme.dev/mcp")).toBe("Acme")
    expect(suggestConnectionName("https://granola.ai/mcp")).toBe("Granola")
  })

  test("returns an empty string for unparseable input", () => {
    expect(suggestConnectionName("not a url")).toBe("")
  })
})

describe("normalizeQueryText", () => {
  test("keeps only lowercased letters and digits", () => {
    expect(normalizeQueryText("Google Drive!")).toBe("googledrive")
    expect(normalizeQueryText("Context7")).toBe("context7")
  })
})

function discovery(overrides: {
  initialize: EnterpriseMcpConnectionRequirements["server"]["initialize"]
  authKind: EnterpriseMcpConnectionRequirements["authentication"]["kind"]
  status?: EnterpriseMcpConnectionRequirements["status"]
}): EnterpriseMcpConnectionRequirements {
  return {
    status: overrides.status ?? "ready",
    server: { url: "https://mcp.example.com/mcp", initialize: overrides.initialize },
    authentication: {
      kind: overrides.authKind,
      authorizationServers: [],
      requiredScopes: [],
      recommendedScopes: [],
      refreshSupport: "unknown",
      availableRegistrationMethods: ["pre_registered"],
      recommendedRegistrationMethod: "pre_registered",
    },
    tools: { visibility: "unavailable" },
    manualRequirements: [],
    warnings: [],
  }
}

describe("discoveryQualifiesAsMcp", () => {
  test("accepts open servers and OAuth-protected servers", () => {
    expect(discoveryQualifiesAsMcp(discovery({ initialize: "succeeded", authKind: "none" }), { guessed: true })).toBe(true)
    expect(discoveryQualifiesAsMcp(discovery({ initialize: "authentication_required", authKind: "oauth" }), { guessed: true })).toBe(true)
  })

  test("rejects a bare 401 on guessed hosts but accepts it for explicit URLs", () => {
    const bearer = discovery({ initialize: "authentication_required", authKind: "manual_bearer" })
    expect(discoveryQualifiesAsMcp(bearer, { guessed: true })).toBe(false)
    expect(discoveryQualifiesAsMcp(bearer, { guessed: false })).toBe(true)
  })

  test("accepts a failed initialize when OAuth resource metadata marks it ready (Vercel)", () => {
    expect(discoveryQualifiesAsMcp(discovery({ initialize: "failed", authKind: "oauth", status: "ready" }), { guessed: true })).toBe(true)
  })

  test("rejects failed initializes without OAuth evidence", () => {
    expect(discoveryQualifiesAsMcp(discovery({ initialize: "failed", authKind: "unknown", status: "unreachable" }), { guessed: false })).toBe(false)
    expect(discoveryQualifiesAsMcp(discovery({ initialize: "failed", authKind: "unknown", status: "unsupported" }), { guessed: true })).toBe(false)
  })
})
