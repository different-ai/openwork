import { createHash } from "node:crypto"
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

test("server-builds React source into a deterministic self-contained MCP App", async () => {
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
  expect(first.html).toContain('<div id="openwork-artifact-view-root"></div>')
  expect(first.html).toContain("ui/initialize")
  expect(first.html).toContain("ui/notifications/tool-result")
  expect(first.html).not.toContain("<script src=")
  expect(first.html).toContain("script-src 'sha256-")
  expect(first.html).not.toContain("script-src 'unsafe-inline'")
  expect(first.html).toContain("form-action 'none'")
  expect(first.html).toContain("object-src 'none'")
  const javascript = first.html.match(/<script>([\s\S]*)<\/script>/iu)?.[1]
  expect(javascript).toBeDefined()
  const scriptDigest = createHash("sha256").update(javascript ?? "").digest("base64")
  expect(first.html).toContain(`script-src 'sha256-${scriptDigest}'`)
  expect(first.resourceDigest).toBe(second.resourceDigest)
  expect(first.sourceDigest).toBe(second.sourceDigest)
  expect(first.csp).toEqual({
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  })
})

test("rejects authored and dynamically selected unsafe HTML elements", async () => {
  const authored = await buildGeneratedArtifactView({
    title: "Unsafe element",
    description: null,
    outputSchema: schema,
    reactSource: `export default function View() { return <script>console.log("unsafe")</script> }`,
  })
  expect(authored.ok).toBe(false)
  expect(authored.diagnostics[0]?.message).toContain("unsafe HTML elements")

  const dynamic = await buildGeneratedArtifactView({
    title: "Dynamic unsafe element",
    description: null,
    outputSchema: schema,
    reactSource: `export default function View() { const Tag = "scr" + "ipt"; return <Tag>console.log("unsafe")</Tag> }`,
  })
  expect(dynamic.ok).toBe(true)
  if (dynamic.ok) expect(dynamic.html).toContain("Generated Artifact views cannot render unsafe HTML elements")
})

test("rejects URL-bearing attributes and external inline styles", async () => {
  const link = await buildGeneratedArtifactView({
    title: "Unsafe link",
    description: null,
    outputSchema: schema,
    reactSource: `export default function View() { return <a href="https://example.com">leave</a> }`,
  })
  expect(link.ok).toBe(false)
  expect(link.diagnostics[0]?.message).toContain("URL-bearing")

  const style = await buildGeneratedArtifactView({
    title: "Unsafe style",
    description: null,
    outputSchema: schema,
    reactSource: `export default function View() { return <div style={{ backgroundImage: "url(https://example.com/x)" }} /> }`,
  })
  expect(style.ok).toBe(false)
  expect(style.diagnostics[0]?.message).toContain("external resources")
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

test("does not execute generated constructor-chain code while building", async () => {
  const secret = "must-not-leak-from-host"
  const previous = process.env.OPENWORK_GENERATED_ARTIFACT_TEST_SECRET
  process.env.OPENWORK_GENERATED_ARTIFACT_TEST_SECRET = secret
  try {
    const result = await buildGeneratedArtifactView({
      title: "Escape attempt",
      description: null,
      outputSchema: schema,
      reactSource: `
        export default function View() {
          const key = "con" + "structor";
          const make = ({} as any)[key][key];
          const read = make("return global" + "This['pro' + 'cess'].env.OPENWORK_GENERATED_ARTIFACT_TEST_SECRET");
          return <div>{read()}</div>;
        }
      `,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.html).not.toContain(secret)
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_GENERATED_ARTIFACT_TEST_SECRET
    else process.env.OPENWORK_GENERATED_ARTIFACT_TEST_SECRET = previous
  }
})

test("rejects bundles larger than the desktop MCP Apps host limit", async () => {
  const result = await buildGeneratedArtifactView({
    title: "Oversized",
    description: null,
    outputSchema: { const: "x".repeat(400_000) },
    reactSource: "export default function View({ data }) { return <div>{data}</div> }",
  })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toContain("524288 bytes")
})
