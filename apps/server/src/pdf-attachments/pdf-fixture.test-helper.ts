import { deflateSync } from "node:zlib";

/**
 * Builds small, valid PDFs for tests without a PDF library. Each entry becomes
 * one US-letter page: a string draws that text with Helvetica, `null` draws a
 * filled rectangle only (a page with no text layer, like a scan), and
 * `{ photo: true }` fills the page with a photo-like raster image (a scan of a
 * picture: no text layer, poor PNG compression).
 */
export type TestPdfPage = string | null | { photo: true };

function photoImage(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 0x2545f491;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 61) - 30;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.max(0, Math.min(255, 128 + 90 * Math.sin(x / 23) + noise()));
      pixels[offset + 1] = Math.max(0, Math.min(255, 128 + 90 * Math.cos(y / 31) + noise()));
      pixels[offset + 2] = Math.max(0, Math.min(255, 128 + 70 * Math.sin((x + y) / 41) + noise()));
    }
  }
  return deflateSync(pixels);
}

export function buildTestPdf(pages: TestPdfPage[]): Buffer {
  const objects: Array<string | { head: string; stream: Buffer }> = [];
  const add = (body: string | { head: string; stream: Buffer }): number => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const PHOTO_WIDTH = 600;
  const PHOTO_HEIGHT = 780;
  const photo = pages.some((page) => page !== null && typeof page === "object")
    ? add({ head: `<< /Type /XObject /Subtype /Image /Width ${PHOTO_WIDTH} /Height ${PHOTO_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: photoImage(PHOTO_WIDTH, PHOTO_HEIGHT) })
    : null;
  const contents = pages.map((page) => {
    const stream = page === null
      ? "0.2 0.4 0.8 rg 100 400 300 200 re f"
      : typeof page === "object"
        ? "q 612 0 0 792 0 0 cm /Im1 Do Q"
        : `BT /F1 20 Tf 72 700 Td (${page.replace(/[\\()]/g, (char) => `\\${char}`)}) Tj ET`;
    return add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  const pagesObject = objects.length + 1 + contents.length;
  const pageObjects = contents.map((content) =>
    add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >>${photo ? ` /XObject << /Im1 ${photo} 0 R >>` : ""} >> /Contents ${content} 0 R >>`),
  );
  add(`<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = chunks[0].byteLength;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const parts = typeof body === "string"
      ? [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]
      : [Buffer.from(`${index + 1} 0 obj\n${body.head} /Length ${body.stream.byteLength} >>\nstream\n`, "latin1"), body.stream, Buffer.from("\nendstream\nendobj\n", "latin1")];
    for (const part of parts) {
      chunks.push(part);
      length += part.byteLength;
    }
  });
  const xref = length;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "latin1"));
  return Buffer.concat(chunks);
}

/** A PDF whose cross-reference table points nowhere useful. */
export function corruptTestPdf(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 9 0 R >>\nstartxref\n999999\n%%EOF\n", "latin1");
}

export function pdfDataUrl(bytes: Buffer): string {
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}
