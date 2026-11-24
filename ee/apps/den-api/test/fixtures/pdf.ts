import { randomBytes } from "node:crypto"

/**
 * A minimal valid PDF: one page per entry, each line drawn in Helvetica. An
 * empty page has no text layer, like a scan. imageBytesPerPage adds an
 * uncompressed, incompressible image to every page, so large image-heavy
 * PDFs can be generated for size and memory checks without a stored fixture.
 */
export function buildPdf(pages: string[][], options: { imageBytesPerPage?: number } = {}): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (character) => `\\${character}`)
  const imageSide = options.imageBytesPerPage ? Math.max(1, Math.floor(Math.sqrt(options.imageBytesPerPage / 3))) : 0
  const perPage = imageSide ? 3 : 2
  const pageIds = pages.map((_, index) => 4 + index * perPage)
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const write = (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk
    chunks.push(buffer)
    length += buffer.byteLength
  }
  const object = (id: number, ...parts: (Buffer | string)[]) => {
    offsets[id] = length
    write(`${id} 0 obj\n`)
    for (const part of parts) write(part)
    write("\nendobj\n")
  }

  write("%PDF-1.4\n")
  object(1, "<< /Type /Catalog /Pages 2 0 R >>")
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`)
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!
    const textOps = lines.length === 0
      ? ""
      : `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`
    const stream = imageSide ? `q 468 0 0 468 72 72 cm /Im1 Do Q ${textOps}` : textOps
    const xObject = imageSide ? ` /XObject << /Im1 ${pageId + 2} 0 R >>` : ""
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${xObject} >> /Contents ${pageId + 1} 0 R >>`)
    object(pageId + 1, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`)
    if (imageSide) {
      const pixels = randomBytes(imageSide * imageSide * 3)
      object(pageId + 2, `<< /Type /XObject /Subtype /Image /Width ${imageSide} /Height ${imageSide} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.byteLength} >>\nstream\n`, pixels, "\nendstream")
    }
  })

  const count = 3 + pages.length * perPage
  const xref = length
  write(`xref\n0 ${count + 1}\n0000000000 65535 f \n`)
  for (let id = 1; id <= count; id += 1) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`)
  write(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Uint8Array(Buffer.concat(chunks, length))
}
