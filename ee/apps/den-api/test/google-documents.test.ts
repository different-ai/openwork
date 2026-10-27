import assert from "node:assert/strict"
import { test } from "node:test"
import { documentTextMatches, parseGoogleDocument, readDocumentPassages } from "../src/capability-sources/google-documents.js"

const paragraph = (startIndex: number, text: string) => ({ paragraph: { elements: [{ startIndex, endIndex: startIndex + text.length, textRun: { content: text } }] } })
function document(content: unknown[]) {
  return parseGoogleDocument({ documentId: "example_doc", title: "Project", revisionId: "revision_one", tabs: [{ tabProperties: { tabId: "main", title: "Main" }, documentTab: { body: { content } } }] })
}

test("reading stays bounded, resumes after emoji, and preserves native indices across table cells", () => {
  const tab = document([paragraph(1, "a".repeat(255) + "😀final\n"), { table: { tableRows: [{ tableCells: [{ content: [paragraph(280, "Budget in table\n")] }] }] } }]).tabs[0]
  const first = readDocumentPassages(tab, { startIndex: 1, maxCharacters: 256 })
  assert.equal(first.passages.map(p => p.text).join(""), "a".repeat(255))
  assert.equal(first.nextStartIndex, 256)
  const second = readDocumentPassages(tab, { startIndex: first.nextStartIndex, maxCharacters: 256 })
  assert.deepEqual(second.passages, [{ startIndex: 256, endIndex: 264, text: "😀final\n" }, { startIndex: 280, endIndex: 296, text: "Budget in table\n" }])
  assert.equal(second.nextStartIndex, null)
  assert.equal(documentTextMatches(tab, 280, "Budget"), true)
  assert.equal(documentTextMatches(tab, 262, "l\nBudget"), false)
  assert.equal(documentTextMatches(tab, 256, "\ud83d"), false)
  assert.equal(documentTextMatches(tab, 257, "\ude00"), false)
  assert.equal(documentTextMatches(tab, 256, "😀"), true)
})

test("search is literal and case-insensitive, spans styled runs, and continues matching without exposing unrelated text", () => {
  const tab = document([{ paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: "Bud" } }, { startIndex: 4, endIndex: 8, textRun: { content: "get\n" } }] } }, paragraph(20, "SECRET unrelated paragraph\n"), paragraph(70, "budget and [.*] literal\n")]).tabs[0]
  const first = readDocumentPassages(tab, { startIndex: 1, maxCharacters: 256, query: "BUDGET" })
  assert.equal(first.passages.length, 1)
  assert.equal(first.nextStartIndex, 70)
  assert.equal(JSON.stringify(first).includes("SECRET"), false)
  assert.equal(readDocumentPassages(tab, { startIndex: 1, maxCharacters: 1000, query: "[.*]" }).passages.length, 1)
  assert.equal(readDocumentPassages(tab, { startIndex: 1, maxCharacters: 1000, query: "missing" }).passages.length, 0)
  assert.equal(documentTextMatches(tab, 1, "Budget"), true)
})

test("nested tabs and headings are indexed, while missing tabs and overlapping or excessive structures fail closed", () => {
  const root = { documentId: "example_doc", title: "Project", tabs: [{ tabProperties: { tabId: "main", title: "Main" }, documentTab: { body: { content: [{ ...paragraph(1, "Overview\n"), paragraph: { ...paragraph(1, "Overview\n").paragraph, paragraphStyle: { namedStyleType: "HEADING_1" } } }] } }, childTabs: [{ tabProperties: { tabId: "child", title: "Detail" }, documentTab: { body: { content: [paragraph(1, "Private detail\n")] } } }] }] }
  const parsed = parseGoogleDocument(root)
  assert.equal(parsed.revisionId, null, "read-only accounts need not return a revision")
  assert.equal(parsed.tabs[1].parentId, "main")
  assert.deepEqual(parsed.tabs[0].headings, [{ startIndex: 1, text: "Overview", style: "HEADING_1" }])
  assert.throws(() => parseGoogleDocument({ documentId: "x", title: "x", body: {} }))
  assert.throws(() => document([paragraph(1, "first"), paragraph(2, "overlap")]))
  assert.throws(() => document(Array.from({ length: 50_001 }, () => ({ sectionBreak: {} }))))
})

test("suggestions are omitted without renumbering later text or allowing edits across the omitted spans", () => {
  const root = { documentId: "example_doc", title: "Review", tabs: [{ tabProperties: { tabId: "main", title: "Main" }, documentTab: { body: { content: [{ paragraph: { elements: [
    { startIndex: 1, endIndex: 5, textRun: { content: "Keep" } },
    { startIndex: 5, endIndex: 13, textRun: { content: "proposed", suggestedInsertionIds: ["suggestion_one"] } },
    { startIndex: 13, endIndex: 19, textRun: { content: " later" } },
  ] } }] } } }] }
  const parsed = parseGoogleDocument(root)
  assert.equal(parsed.suggestionsOmitted, true)
  assert.deepEqual(parsed.tabs[0].passages, [{ startIndex: 1, endIndex: 5, text: "Keep" }, { startIndex: 13, endIndex: 19, text: " later" }])
  assert.equal(documentTextMatches(parsed.tabs[0], 1, "Keep later"), false)
  assert.equal(documentTextMatches(parsed.tabs[0], 14, "later"), true)
  assert.equal(readDocumentPassages(parsed.tabs[0], { startIndex: 1, maxCharacters: 256, query: "proposed" }).passages.length, 0)
})
