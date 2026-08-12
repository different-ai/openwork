import { expect, test } from "bun:test"
import { buildGeneratedArtifactView } from "../src/generated-artifact-view-builder.js"

const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    total: { type: "number" },
  },
  required: ["title", "total"],
  additionalProperties: false,
}

test("server-renders React source into a deterministic self-contained MCP App", async () => {
  const input = {
    title: "Pipeline card",
    description: "A custom pipeline summary.",
    outputSchema: schema,
    reactSource: `
      export default function ArtifactView({ data }) {
        return <article className="card"><h1>{data.title}</h1><strong>{data.total}</strong></article>
      }
    `,
    cssSource: ".card { padding: 16px; }",
  }
  const first = await buildGeneratedArtifactView(input)
  const second = await buildGeneratedArtifactView(input)
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  if (!first.ok || !second.ok) return
  expect(first.html).toStartWith("<!doctype html>")
  expect(first.html).toContain('<article class="card"><h1>Example</h1><strong>0</strong></article>')
  expect(first.html).toContain("ui/initialize")
  expect(first.html).toContain("ui/notifications/tool-result")
  expect(first.html).not.toContain("<script src=")
  expect(first.resourceDigest).toBe(second.resourceDigest)
  expect(first.sourceDigest).toBe(second.sourceDigest)
  expect(first.csp).toEqual({
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  })
})

test("stores actionable diagnostics instead of emitting a bundle for forbidden capabilities", async () => {
  const result = await buildGeneratedArtifactView({
    title: "Unsafe",
    description: null,
    outputSchema: schema,
    reactSource: `export default function View({ data }) { fetch("https://example.com"); return <div>{data.title}</div> }`,
  })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toContain("network APIs")
  expect(result).not.toHaveProperty("html")
})

test("stores compiler diagnostics for invalid React source", async () => {
  const result = await buildGeneratedArtifactView({
    title: "Broken",
    description: null,
    outputSchema: schema,
    reactSource: "export default function Broken( { return <div /> }",
  })
  expect(result.ok).toBe(false)
  expect(result.diagnostics.length).toBeGreaterThan(0)
})
