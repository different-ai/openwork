import { getDocumentProxy } from "unpdf"

export type PdfTextResult =
  | { kind: "text"; text: string; truncated: boolean; pageCount: number }
  /** A PDF with no text layer, such as a scan; its pages are images. */
  | { kind: "no_text"; pageCount: number }
  /** Not a PDF pdf.js can open (damaged, encrypted, or not a PDF at all). */
  | { kind: "unreadable" }

/**
 * Extracts a PDF's text layer, page by page, stopping once maxCharacters is
 * reached so a long document is cut rather than parsed whole. Pages are
 * separated by a blank line. Callers bound the input size before calling.
 */
export async function extractPdfText(bytes: Uint8Array, options: { maxCharacters: number }): Promise<PdfTextResult> {
  let document: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given, so pass a copy.
    document = await getDocumentProxy(bytes.slice(), { disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  } catch {
    return { kind: "unreadable" }
  }

  try {
    const pageCount = document.numPages
    const pages: string[] = []
    let length = 0
    let pagesRead = 0
    while (pagesRead < pageCount && length <= options.maxCharacters) {
      pagesRead += 1
      const page = await document.getPage(pagesRead)
      const content = await page.getTextContent()
      page.cleanup()
      const text = content.items
        .map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "")
        .join("")
        .trim()
      if (!text) continue
      pages.push(text)
      length += text.length + 2
    }

    const joined = pages.join("\n\n")
    if (!joined) return { kind: "no_text", pageCount }
    const truncated = pagesRead < pageCount || joined.length > options.maxCharacters
    return { kind: "text", text: joined.slice(0, options.maxCharacters), truncated, pageCount }
  } catch {
    return { kind: "unreadable" }
  } finally {
    // Destroying the loading task frees the document and its worker-side resources.
    await document.loadingTask.destroy().catch(() => {})
  }
}
