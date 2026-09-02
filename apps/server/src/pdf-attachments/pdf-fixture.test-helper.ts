/**
 * Builds small, valid PDFs for tests without a PDF library. Each entry becomes
 * one US-letter page: a string draws that text with Helvetica, `null` draws a
 * filled rectangle only (a page with no text layer, like a scan).
 */
export function buildTestPdf(pages: Array<string | null>): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contents = pages.map((text) => {
    const stream = text === null
      ? "0.2 0.4 0.8 rg 100 400 300 200 re f"
      : `BT /F1 20 Tf 72 700 Td (${text.replace(/[\\()]/g, (char) => `\\${char}`)}) Tj ET`;
    return add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  const pagesObject = objects.length + 1 + contents.length;
  const pageObjects = contents.map((content) =>
    add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
  );
  add(`<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A PDF whose cross-reference table points nowhere useful. */
export function corruptTestPdf(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 9 0 R >>\nstartxref\n999999\n%%EOF\n", "latin1");
}

export function pdfDataUrl(bytes: Buffer): string {
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}
