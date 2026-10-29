/** Google Docs body text, including nested tabs and tables. Indices use Google's UTF-16 offsets. */
export type DocumentPassage = { startIndex: number; endIndex: number; text: string }
export type DocumentTab = { id: string; title: string; parentId: string | null; passages: DocumentPassage[]; headings: { startIndex: number; text: string; style: string }[] }
export type GoogleDocument = { documentId: string; title: string; revisionId: string | null; tabs: DocumentTab[]; suggestionsOmitted: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid Google document structure")
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid Google document list")
  return value
}
function label(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid Google document label")
  return value
}
function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Google document index")
  return value
}

export function parseGoogleDocument(value: unknown): GoogleDocument {
  const root = record(value)
  const tabs: DocumentTab[] = []
  let elements = 0
  let suggestionsOmitted = false
  const ids = new Set<string>()
  function suggested(value: Record<string, unknown>) {
    const found = [value.suggestedInsertionIds, value.suggestedDeletionIds].some(ids => Array.isArray(ids) && ids.length > 0)
    suggestionsOmitted ||= found
    return found
  }
  function content(raw: unknown, tab: DocumentTab, depth = 0) {
    if (depth > 24) throw new Error("Google document nesting limit exceeded")
    for (const entry of array(raw)) {
      if (++elements > 50_000) throw new Error("Google document structure limit exceeded")
      const block = record(entry)
      if (block.paragraph) {
        const paragraph = record(block.paragraph)
        const chunks: DocumentPassage[] = []
        for (const rawElement of array(paragraph.elements)) {
          if (++elements > 50_000) throw new Error("Google document structure limit exceeded")
          const element = record(rawElement)
          if (!element.textRun) continue
          const run = record(element.textRun)
          if (suggested(run)) continue
          const text = label(run.content, 6 * 1024 * 1024)
          const startIndex = index(element.startIndex)
          const endIndex = index(element.endIndex)
          if (endIndex - startIndex !== text.length) throw new Error("Google document text indices do not match")
          const last = chunks.at(-1)
          if (last && last.endIndex === startIndex) { last.text += text; last.endIndex = endIndex }
          else chunks.push({ startIndex, endIndex, text })
        }
        const style = paragraph.paragraphStyle ? record(paragraph.paragraphStyle).namedStyleType : undefined
        if (typeof style === "string" && /^(HEADING_[1-6]|TITLE|SUBTITLE)$/.test(style) && chunks.length) {
          tab.headings.push({ startIndex: chunks[0].startIndex, text: chunks.map(chunk => chunk.text).join("").trim().slice(0, 200), style })
        }
        tab.passages.push(...chunks)
      }
      if (block.table && !suggested(record(block.table))) for (const row of array(record(block.table).tableRows)) {
        if (suggested(record(row))) continue
        for (const cell of array(record(row).tableCells)) if (!suggested(record(cell))) content(record(cell).content, tab, depth + 1)
      }
      if (block.tableOfContents) content(record(block.tableOfContents).content, tab, depth + 1)
    }
  }
  function visit(raw: unknown, parentId: string | null, depth = 0) {
    if (depth > 8) throw new Error("Google document tab nesting limit exceeded")
    for (const entry of array(raw)) {
      if (tabs.length >= 100) throw new Error("Google document tab limit exceeded")
      const source = record(entry)
      const properties = record(source.tabProperties)
      const id = label(properties.tabId, 512)
      if (!id || ids.has(id)) throw new Error("Invalid or duplicate Google document tab")
      ids.add(id)
      const tab: DocumentTab = { id, title: label(properties.title, 1000), parentId, passages: [], headings: [] }
      tabs.push(tab)
      const body = source.documentTab ? record(source.documentTab).body : undefined
      if (body) content(record(body).content ?? [], tab)
      tab.passages.sort((a, b) => a.startIndex - b.startIndex)
      for (let i = 1; i < tab.passages.length; i++) {
        if (tab.passages[i].startIndex < tab.passages[i - 1].endIndex) throw new Error("Overlapping Google document text")
      }
      if (source.childTabs) visit(source.childTabs, id, depth + 1)
    }
  }
  visit(root.tabs, null)
  if (!tabs.length) throw new Error("Google document has no readable tabs")
  return { documentId: label(root.documentId, 512), title: label(root.title, 1000), revisionId: root.revisionId === undefined ? null : label(root.revisionId, 512), tabs, suggestionsOmitted }
}

/** Keep boundaries between surrogate pairs so pagination neither loses nor corrupts emoji. */
function slicePassage(passage: DocumentPassage, startIndex: number, maxCharacters: number): DocumentPassage {
  let start = Math.max(0, startIndex - passage.startIndex)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(passage.text[start] ?? "") && /[\uD800-\uDBFF]/.test(passage.text[start - 1])) start--
  let end = Math.min(passage.text.length, start + maxCharacters)
  if (end < passage.text.length && /[\uDC00-\uDFFF]/.test(passage.text[end]) && /[\uD800-\uDBFF]/.test(passage.text[end - 1])) end--
  return { startIndex: passage.startIndex + start, endIndex: passage.startIndex + end, text: passage.text.slice(start, end) }
}

export function readDocumentPassages(tab: DocumentTab, input: { startIndex: number; maxCharacters: number; query?: string }) {
  const passages: DocumentPassage[] = []
  let remaining = input.maxCharacters
  let nextStartIndex: number | null = null
  // Literal, Unicode case-insensitive search; escaping prevents user-supplied regular expressions.
  const expression = input.query ? new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null
  for (const source of tab.passages) {
    if (source.endIndex <= input.startIndex) continue
    if (expression) {
      expression.lastIndex = Math.max(0, input.startIndex - source.startIndex)
      let match: RegExpExecArray | null
      while ((match = expression.exec(source.text)) !== null) {
        const position = source.startIndex + match.index
        const previous = passages.at(-1)
        if (previous && previous.startIndex <= position && previous.endIndex >= position + match[0].length) continue
        if (remaining < 256 || passages.length >= 20) { nextStartIndex = position; break }
        const snippet = slicePassage(source, Math.max(input.startIndex, position - 100), Math.min(remaining, Math.max(256, match[0].length + 200)))
        passages.push(snippet)
        remaining -= snippet.text.length
      }
    } else {
      if (!remaining || passages.length >= 100) { nextStartIndex = Math.max(input.startIndex, source.startIndex); break }
      const snippet = slicePassage(source, input.startIndex, remaining)
      passages.push(snippet)
      remaining -= snippet.text.length
      if (snippet.endIndex < source.endIndex) nextStartIndex = snippet.endIndex
    }
    if (nextStartIndex !== null) break
  }
  return { passages, nextStartIndex }
}

/** A precise edit stays inside one text span and never deletes structural boundaries. */
export function documentTextMatches(tab: DocumentTab, startIndex: number, expectedText: string): boolean {
  return tab.passages.some(passage => {
    const start = startIndex - passage.startIndex
    const end = start + expectedText.length
    const splitsSurrogate = (offset: number) => offset > 0 && /[\uDC00-\uDFFF]/.test(passage.text[offset] ?? "") && /[\uD800-\uDBFF]/.test(passage.text[offset - 1])
    return start >= 0 && end <= passage.text.length && !splitsSurrogate(start) && !splitsSurrogate(end)
      && passage.text.slice(start, end) === expectedText
  })
}
