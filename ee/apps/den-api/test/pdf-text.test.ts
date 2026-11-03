import assert from "node:assert/strict"
import { test } from "node:test"
import { extractPdfText } from "../src/capability-sources/pdf-text.js"
import { readBytesWithin } from "../src/capability-sources/binary-content.js"
import { buildPdf } from "./fixtures/pdf.js"

const limits = { maxCharacters: 10_000, timeoutMs: 15_000 }

test("a PDF's text layer comes back page by page, read in a worker that takes the bytes", async () => {
  const bytes = buildPdf([["Work breakdown", "Phase 1: discovery (2 weeks)"], ["Phase 2: rollout (3 weeks)"]])
  const result = await extractPdfText(bytes, limits)
  assert.equal(result.kind, "text")
  if (result.kind !== "text") return
  assert.equal(result.pageCount, 2)
  assert.equal(result.truncated, false)
  assert.match(result.text, /Work breakdown/)
  assert.match(result.text, /Phase 1: discovery \(2 weeks\)/)
  assert.ok(result.text.indexOf("Phase 1") < result.text.indexOf("Phase 2"), "pages keep their order")
  assert.equal(bytes.byteLength, 0, "the buffer was transferred to the worker, not copied")
})

test("a long PDF is cut at the character limit and marked truncated", async () => {
  const pages = Array.from({ length: 50 }, (_, index) => [`Page ${index + 1} ${"x".repeat(200)}`])
  const result = await extractPdfText(buildPdf(pages), { ...limits, maxCharacters: 500 })
  assert.equal(result.kind, "text")
  if (result.kind !== "text") return
  assert.equal(result.text.length <= 500, true)
  assert.equal(result.truncated, true)
  assert.equal(result.pageCount, 50)
})

test("a PDF without a text layer and bytes that are not a PDF are told apart", async () => {
  assert.deepEqual(await extractPdfText(buildPdf([[], []]), limits), { kind: "no_text", pageCount: 2 })
  assert.deepEqual(await extractPdfText(new TextEncoder().encode("not a pdf"), limits), { kind: "unreadable" })
})

test("extraction past its deadline stops with timed_out instead of hanging", async () => {
  const large = buildPdf(Array.from({ length: 40 }, () => ["text"]), { imageBytesPerPage: 256 * 1024 })
  const started = Date.now()
  assert.deepEqual(await extractPdfText(large, { ...limits, timeoutMs: 1 }), { kind: "timed_out" })
  assert.ok(Date.now() - started < 5_000)
  // The extraction slot is released: the next PDF is still read.
  assert.equal((await extractPdfText(buildPdf([["after"]]), limits)).kind, "text")
})

test("a download is read only while it fits under the limit", async () => {
  const body = (size: number, headers: Record<string, string> = {}) => new Response(new Uint8Array(size), { headers })
  assert.equal((await readBytesWithin(body(10, { "content-length": "10" }), 10))?.byteLength, 10)
  assert.equal(await readBytesWithin(body(11, { "content-length": "11" }), 10), null, "a declared size over the limit is refused")
  const chunked = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(4)) },
  }))
  assert.equal(await readBytesWithin(chunked, 10), null, "an undeclared stream is cut off once it passes the limit")
  const understated = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(4)) },
  }), { headers: { "content-length": "6" } })
  assert.equal(await readBytesWithin(understated, 10), null, "a body longer than its declared size is cut off")
})
