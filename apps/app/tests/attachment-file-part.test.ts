import { describe, expect, test } from "bun:test";

import type { ComposerAttachment } from "../src/app/types";
import { composerAttachmentToFilePart, resolveAttachmentFileMetadata } from "../src/react-app/domains/session/sync/attachment-file-part";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function attachmentFor(file: File, metadata: Partial<Pick<ComposerAttachment, "name" | "mimeType" | "kind">> = {}): ComposerAttachment {
  return {
    id: "attachment-1",
    name: metadata.name ?? file.name,
    mimeType: metadata.mimeType ?? file.type,
    size: file.size,
    kind: metadata.kind ?? (file.type.startsWith("image/") ? "image" : "file"),
    file,
  };
}

function decodedDataUrlBytes(url: string) {
  const marker = ";base64,";
  const markerIndex = url.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(0);
  const binary = atob(url.slice(markerIndex + marker.length));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

describe("composer attachment file parts", () => {
  test("preserves JPEG filename, mime, data URL, and exact bytes", async () => {
    const file = new File([JPEG_BYTES], "PassaportoPaolo_small.jpg", { type: "image/jpeg" });
    const part = await composerAttachmentToFilePart(attachmentFor(file));

    expect(part.filename).toBe("PassaportoPaolo_small.jpg");
    expect(part.mime).toBe("image/jpeg");
    expect(part.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(Array.from(decodedDataUrlBytes(part.url))).toEqual(Array.from(JPEG_BYTES));
  });

  test("stale ComposerAttachment PDF metadata cannot override an underlying JPEG File", async () => {
    const file = new File([JPEG_BYTES], "PassaportoPaolo_small.jpg", { type: "image/jpeg" });
    const part = await composerAttachmentToFilePart(attachmentFor(file, {
      name: "PassaportoPaolo_small.pdf",
      mimeType: "application/pdf",
      kind: "file",
    }));

    expect(part.filename).toBe("PassaportoPaolo_small.jpg");
    expect(part.mime).toBe("image/jpeg");
    expect(part.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("generic MIME resolves from supported .pdf and .png extensions", () => {
    expect(resolveAttachmentFileMetadata(new File([JPEG_BYTES], "scan.pdf", { type: "application/octet-stream" }))).toMatchObject({
      filename: "scan.pdf",
      mime: "application/pdf",
      kind: "file",
      readable: true,
    });
    expect(resolveAttachmentFileMetadata(new File([JPEG_BYTES], "scan.png", { type: "" }))).toMatchObject({
      filename: "scan.png",
      mime: "image/png",
      kind: "image",
      readable: true,
    });
  });

  test("known MIME and filename extension conflicts normalize outbound filename extension", async () => {
    const imageNamedPdf = new File([JPEG_BYTES], "PassaportoPaolo_small.pdf", { type: "image/jpeg" });
    const pdfNamedPng = new File([JPEG_BYTES], "scan.png", { type: "application/pdf" });

    expect((await composerAttachmentToFilePart(attachmentFor(imageNamedPdf))).filename).toBe("PassaportoPaolo_small.jpg");
    expect((await composerAttachmentToFilePart(attachmentFor(pdfNamedPng))).filename).toBe("scan.pdf");
  });
});
