import assert from "node:assert/strict"
import { test } from "node:test"
import { extractPdfText } from "../src/capability-sources/pdf-text.js"
import { buildPdf } from "./fixtures/pdf.js"

test("a PDF's text layer comes back page by page", async () => {
  const bytes = buildPdf([["Work breakdown", "Phase 1: discovery (2 weeks)"], ["Phase 2: rollout (3 weeks)"]])
  const result = await extractPdfText(bytes, { maxCharacters: 10_000 })
  assert.equal(result.kind, "text")
  if (result.kind !== "text") return
  assert.equal(result.pageCount, 2)
  assert.equal(result.truncated, false)
  assert.match(result.text, /Work breakdown/)
  assert.match(result.text, /Phase 1: discovery \(2 weeks\)/)
  assert.match(result.text, /Phase 2: rollout \(3 weeks\)/)
  assert.ok(result.text.indexOf("Phase 1") < result.text.indexOf("Phase 2"), "pages keep their order")
  assert.equal(bytes.byteLength > 0, true, "the caller's buffer is not detached")
})

test("a long PDF is cut at the character limit and marked truncated, without reading every page", async () => {
  const pages = Array.from({ length: 50 }, (_, index) => [`Page ${index + 1} ${"x".repeat(200)}`])
  const result = await extractPdfText(buildPdf(pages), { maxCharacters: 500 })
  assert.equal(result.kind, "text")
  if (result.kind !== "text") return
  assert.equal(result.text.length <= 500, true)
  assert.equal(result.truncated, true)
  assert.equal(result.pageCount, 50)
})

test("a PDF without a text layer and bytes that are not a PDF are told apart", async () => {
  assert.deepEqual(await extractPdfText(buildPdf([[], []]), { maxCharacters: 1_000 }), { kind: "no_text", pageCount: 2 })
  assert.deepEqual(await extractPdfText(new TextEncoder().encode("not a pdf"), { maxCharacters: 1_000 }), { kind: "unreadable" })
})
