/** A minimal valid PDF: one page per entry, each line drawn in Helvetica. An empty page has no text layer, like a scan. */
export function buildPdf(pages: string[][]): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (character) => `\\${character}`)
  const pageIds = pages.map((_, index) => 4 + index * 2)
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ])
  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!
    const stream = lines.length === 0
      ? ""
      : `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`)
    objects.set(pageId + 1, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`)
  })

  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  const count = objects.size
  for (let id = 1; id <= count; id += 1) {
    offsets[id] = Buffer.byteLength(body, "latin1")
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, "latin1")
  body += `xref\n0 ${count + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= count; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, "latin1"))
}
