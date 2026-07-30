import { describe, expect, test } from "bun:test";

import type { ComposerAttachment } from "../src/app/types";
import {
  buildChatAttachmentInboxPath,
  composerAttachmentsToWorkspaceFileParts,
  composerAttachmentToFilePart,
  modelFacingAttachmentMime,
  resolveAttachmentFileMetadata,
  safeAttachmentFilename,
  workspaceInboxPath,
  type ChatAttachmentWorkspaceEndpoint,
} from "../src/react-app/domains/session/sync/attachment-file-part";

async function requireFilePart(attachment: ComposerAttachment) {
  const part = await composerAttachmentToFilePart(attachment);
  if (!part) throw new Error("Expected a model-facing file part");
  return part;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x77, 0x6f, 0x72, 0x64]);
const PPTX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x70, 0x70, 0x74, 0x78]);
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x78, 0x6c, 0x73, 0x78]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);

type UploadCall = {
  workspaceId: string;
  path: string;
  filename: string;
  bytes: number[];
};

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

function uploadRecorder(workspaceId: string) {
  const calls: UploadCall[] = [];
  const endpoint: ChatAttachmentWorkspaceEndpoint = {
    workspaceId,
    client: {
      uploadInbox: async (id, file, options) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = options?.path?.trim() || file.name;
        calls.push({
          workspaceId: id,
          path,
          filename: file.name,
          bytes: Array.from(bytes),
        });
        return { ok: true, path, bytes: file.size };
      },
    },
  };
  return { endpoint, calls };
}

function textPart(parts: Awaited<ReturnType<typeof composerAttachmentsToWorkspaceFileParts>>) {
  const part = parts[0];
  if (!part || part.type !== "text") throw new Error("Expected first attachment part to be a text note");
  return part;
}

function textPartText(parts: Awaited<ReturnType<typeof composerAttachmentsToWorkspaceFileParts>>) {
  return textPart(parts).text;
}

function filePartUrl(parts: Awaited<ReturnType<typeof composerAttachmentsToWorkspaceFileParts>>, index: number) {
  const part = parts[index];
  if (!part || part.type !== "file") throw new Error(`Expected attachment part ${index} to be a file`);
  return part.url;
}

describe("composer attachment file parts", () => {
  test("preserves JPEG filename, mime, data URL, and exact bytes", async () => {
    const file = new File([JPEG_BYTES], "PassaportoPaolo_small.jpg", { type: "image/jpeg" });
    const part = await requireFilePart(attachmentFor(file));

    expect(part.filename).toBe("PassaportoPaolo_small.jpg");
    expect(part.mime).toBe("image/jpeg");
    expect(part.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(Array.from(decodedDataUrlBytes(part.url))).toEqual(Array.from(JPEG_BYTES));
  });

  test("stale ComposerAttachment PDF metadata cannot override an underlying JPEG File", async () => {
    const file = new File([JPEG_BYTES], "PassaportoPaolo_small.jpg", { type: "image/jpeg" });
    const part = await requireFilePart(attachmentFor(file, {
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
    });
    expect(resolveAttachmentFileMetadata(new File([JPEG_BYTES], "scan.png", { type: "" }))).toMatchObject({
      filename: "scan.png",
      mime: "image/png",
      kind: "image",
    });
  });

  test("preserves canonical Office MIME, data URL headers, filenames, and exact bytes", async () => {
    const docx = new File([DOCX_BYTES], "PlanningMemo.docx", { type: DOCX_MIME });
    const pptx = new File([PPTX_BYTES], "RoadshowDeck.pptx", { type: PPTX_MIME });
    const xlsx = new File([XLSX_BYTES], "RevenueWorkbook.xlsx", { type: XLSX_MIME });

    expect(resolveAttachmentFileMetadata(docx)).toMatchObject({
      filename: "PlanningMemo.docx",
      mime: DOCX_MIME,
      kind: "file",
    });
    expect(resolveAttachmentFileMetadata(pptx)).toMatchObject({
      filename: "RoadshowDeck.pptx",
      mime: PPTX_MIME,
      kind: "file",
    });
    expect(resolveAttachmentFileMetadata(xlsx)).toMatchObject({
      filename: "RevenueWorkbook.xlsx",
      mime: XLSX_MIME,
      kind: "file",
    });

    const docxPart = await requireFilePart(attachmentFor(docx));
    const pptxPart = await requireFilePart(attachmentFor(pptx));
    const xlsxPart = await requireFilePart(attachmentFor(xlsx));

    expect(docxPart.filename).toBe("PlanningMemo.docx");
    expect(docxPart.mime).toBe(DOCX_MIME);
    expect(docxPart.url.startsWith(`data:${DOCX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(docxPart.url))).toEqual(Array.from(DOCX_BYTES));

    expect(pptxPart.filename).toBe("RoadshowDeck.pptx");
    expect(pptxPart.mime).toBe(PPTX_MIME);
    expect(pptxPart.url.startsWith(`data:${PPTX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(pptxPart.url))).toEqual(Array.from(PPTX_BYTES));

    expect(xlsxPart.filename).toBe("RevenueWorkbook.xlsx");
    expect(xlsxPart.mime).toBe(XLSX_MIME);
    expect(xlsxPart.url.startsWith(`data:${XLSX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(xlsxPart.url))).toEqual(Array.from(XLSX_BYTES));
  });

  test("resolves generic Office MIME from case-insensitive extensions without coercing bytes to text", async () => {
    const docx = new File([DOCX_BYTES], "QuarterlyReport.DOCX", { type: "application/octet-stream" });
    const pptx = new File([PPTX_BYTES], "LaunchPlan.PPTX", { type: "" });
    const xlsx = new File([XLSX_BYTES], "BudgetModel.XLSX", { type: "application/octet-stream" });

    expect(resolveAttachmentFileMetadata(docx)).toMatchObject({
      filename: "QuarterlyReport.DOCX",
      mime: DOCX_MIME,
      kind: "file",
    });
    expect(resolveAttachmentFileMetadata(pptx)).toMatchObject({
      filename: "LaunchPlan.PPTX",
      mime: PPTX_MIME,
      kind: "file",
    });
    expect(resolveAttachmentFileMetadata(xlsx)).toMatchObject({
      filename: "BudgetModel.XLSX",
      mime: XLSX_MIME,
      kind: "file",
    });

    const docxPart = await requireFilePart(attachmentFor(docx));
    const pptxPart = await requireFilePart(attachmentFor(pptx));
    const xlsxPart = await requireFilePart(attachmentFor(xlsx));

    expect(docxPart.filename).toBe("QuarterlyReport.DOCX");
    expect(docxPart.mime).toBe(DOCX_MIME);
    expect(docxPart.url.startsWith(`data:${DOCX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(docxPart.url))).toEqual(Array.from(DOCX_BYTES));

    expect(pptxPart.filename).toBe("LaunchPlan.PPTX");
    expect(pptxPart.mime).toBe(PPTX_MIME);
    expect(pptxPart.url.startsWith(`data:${PPTX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(pptxPart.url))).toEqual(Array.from(PPTX_BYTES));

    expect(xlsxPart.filename).toBe("BudgetModel.XLSX");
    expect(xlsxPart.mime).toBe(XLSX_MIME);
    expect(xlsxPart.url.startsWith(`data:${XLSX_MIME};base64,`)).toBe(true);
    expect(Array.from(decodedDataUrlBytes(xlsxPart.url))).toEqual(Array.from(XLSX_BYTES));
  });

  test("normalizes Office filename extensions from canonical MIME when filenames disagree", async () => {
    const docxNamedBin = new File([DOCX_BYTES], "PlanningMemo.bin", { type: DOCX_MIME });
    const pptxWithoutExtension = new File([PPTX_BYTES], "RoadshowDeck", { type: PPTX_MIME });
    const xlsxWithoutExtension = new File([XLSX_BYTES], "RevenueWorkbook", { type: XLSX_MIME });

    expect((await requireFilePart(attachmentFor(docxNamedBin))).filename).toBe("PlanningMemo.docx");
    expect((await requireFilePart(attachmentFor(pptxWithoutExtension))).filename).toBe("RoadshowDeck.pptx");
    expect((await requireFilePart(attachmentFor(xlsxWithoutExtension))).filename).toBe("RevenueWorkbook.xlsx");
  });

  test("routes model-facing mimes: providers only accept image/*, PDF, and text/plain file parts", () => {
    // Text-like content is re-mimed to text/plain so opencode inlines it (the @file mechanism).
    expect(modelFacingAttachmentMime("text/xml")).toBe("text/plain");
    expect(modelFacingAttachmentMime("text/csv")).toBe("text/plain");
    expect(modelFacingAttachmentMime("application/json")).toBe("text/plain");
    expect(modelFacingAttachmentMime("application/xml")).toBe("text/plain");
    expect(modelFacingAttachmentMime("application/javascript")).toBe("text/plain");
    expect(modelFacingAttachmentMime("application/ld+json")).toBe("text/plain");
    expect(modelFacingAttachmentMime("image/svg+xml")).toBe("text/plain");
    expect(modelFacingAttachmentMime("text/plain; charset=utf-8")).toBe("text/plain");
    // Provider-native formats pass through (Office is rewritten server-side by the plugin).
    expect(modelFacingAttachmentMime("image/png")).toBe("image/png");
    expect(modelFacingAttachmentMime("application/pdf")).toBe("application/pdf");
    expect(modelFacingAttachmentMime(DOCX_MIME)).toBe(DOCX_MIME);
    // Binary/unknown formats get no model-facing file part; tools use the workspace path.
    expect(modelFacingAttachmentMime("application/octet-stream")).toBeNull();
    expect(modelFacingAttachmentMime("application/zip")).toBeNull();
    expect(modelFacingAttachmentMime("audio/mpeg")).toBeNull();
    expect(modelFacingAttachmentMime("application/x-iwork-keynote-sffkey")).toBeNull();
  });

  test("accepts unsupported binary attachments without producing a model-facing file part", async () => {
    expect(resolveAttachmentFileMetadata(new File([PPTX_BYTES], "archive.zip", { type: "" }))).toMatchObject({
      filename: "archive.zip",
      mime: "application/octet-stream",
      kind: "file",
    });
    const binary = new File([PPTX_BYTES], "board.key", { type: "application/x-iwork-keynote-sffkey" });
    expect(await composerAttachmentToFilePart(attachmentFor(binary))).toBeNull();
  });

  test("text-like attachments are sent as text/plain file parts with original filenames", async () => {
    const xml = new File(["<agenda><item>Kickoff</item></agenda>"], "agenda.xml", { type: "text/xml" });
    const part = await requireFilePart(attachmentFor(xml));

    expect(part.filename).toBe("agenda.xml");
    expect(part.mime).toBe("text/plain");
    expect(part.url.startsWith("data:text/plain;base64,")).toBe(true);

    const csv = new File(["a,b\n1,2\n"], "rows.csv", { type: "" });
    expect((await requireFilePart(attachmentFor(csv))).mime).toBe("text/plain");
    const json = new File(["{}"], "config.json", { type: "application/json" });
    expect((await requireFilePart(attachmentFor(json))).mime).toBe("text/plain");
  });

  test("known MIME and filename extension conflicts normalize outbound filename extension", async () => {
    const imageNamedPdf = new File([JPEG_BYTES], "PassaportoPaolo_small.pdf", { type: "image/jpeg" });
    const pdfNamedPng = new File([JPEG_BYTES], "scan.png", { type: "application/pdf" });

    expect((await requireFilePart(attachmentFor(imageNamedPdf))).filename).toBe("PassaportoPaolo_small.jpg");
    expect((await requireFilePart(attachmentFor(pdfNamedPng))).filename).toBe("scan.pdf");
  });

  test("sanitizes desktop-style filenames without leaking local path segments", () => {
    expect(safeAttachmentFilename("C:\\Users\\omar\\Scans\\scan one 李?.pdf")).toBe("scan one 李_.pdf");
    expect(resolveAttachmentFileMetadata(new File([PDF_BYTES], "C:\\Users\\omar\\scan one 李.pdf", { type: "application/pdf" }))).toMatchObject({
      filename: "scan one 李.pdf",
      mime: "application/pdf",
    });
  });

  test("generates session-scoped inbox paths under the workspace inbox", () => {
    const inboxPath = buildChatAttachmentInboxPath({
      sessionId: "ses_123",
      id: "nonce-abc",
      filename: "scan one 李.pdf",
    });

    expect(inboxPath).toBe("chat-attachments/ses_123/nonce-abc-scan one 李.pdf");
    expect(workspaceInboxPath(inboxPath)).toBe(".opencode/openwork/inbox/chat-attachments/ses_123/nonce-abc-scan one 李.pdf");
  });

  test("uploads exact bytes to the endpoint workspace id and exposes a worker file URL plus path note", async () => {
    const { endpoint, calls } = uploadRecorder("server-workspace-42");
    const file = new File([PDF_BYTES], "image-only scan.pdf", { type: "application/pdf" });

    const parts = await composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_abc",
      workspaceRoot: "/workspaces/Worker Root",
      createId: () => "nonce-a",
    });

    expect(calls).toEqual([{
      workspaceId: "server-workspace-42",
      path: "chat-attachments/ses_abc/nonce-a-image-only scan.pdf",
      filename: "image-only scan.pdf",
      bytes: Array.from(PDF_BYTES),
    }]);
    expect(textPart(parts)).toMatchObject({
      type: "text",
      synthetic: true,
    });
    expect(textPartText(parts).startsWith("Attached files were copied")).toBe(true);
    expect(textPartText(parts)).toContain(".opencode/openwork/inbox/chat-attachments/ses_abc/nonce-a-image-only scan.pdf");
    expect(textPartText(parts)).toContain("Read/Bash/MCP/Docling");
    expect(filePartUrl(parts, 1)).toBe("file:///workspaces/Worker%20Root/.opencode/openwork/inbox/chat-attachments/ses_abc/nonce-a-image-only%20scan.pdf");
    expect(parts[1]).toMatchObject({
      type: "file",
      filename: "image-only scan.pdf",
      mime: "application/pdf",
    });
  });

  test("workspace image attachments use displayable data URLs while keeping a synthetic path note for tools", async () => {
    const { endpoint, calls } = uploadRecorder("server-workspace-42");
    const file = new File([JPEG_BYTES], "shot.png", { type: "image/png" });

    const parts = await composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_img",
      workspaceRoot: "/workspaces/Worker Root",
      createId: () => "nonce-img",
    });

    expect(calls).toEqual([{
      workspaceId: "server-workspace-42",
      path: "chat-attachments/ses_img/nonce-img-shot.png",
      filename: "shot.png",
      bytes: Array.from(JPEG_BYTES),
    }]);
    expect(textPart(parts)).toMatchObject({ type: "text", synthetic: true });
    expect(textPartText(parts)).toContain(".opencode/openwork/inbox/chat-attachments/ses_img/nonce-img-shot.png");
    expect(textPartText(parts)).toContain("file:///workspaces/Worker%20Root/.opencode/openwork/inbox/chat-attachments/ses_img/nonce-img-shot.png");
    expect(filePartUrl(parts, 1).startsWith("data:image/png;base64,")).toBe(true);
    expect(Array.from(decodedDataUrlBytes(filePartUrl(parts, 1)))).toEqual(Array.from(JPEG_BYTES));
    expect(parts[1]).toMatchObject({
      type: "file",
      filename: "shot.png",
      mime: "image/png",
    });
  });

  test("workspace text-like attachments become text/plain file parts pointing at the workspace copy", async () => {
    const { endpoint, calls } = uploadRecorder("server-workspace-42");
    const file = new File(["<a/>"], "sitemap.xml", { type: "text/xml" });

    const parts = await composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_xml",
      workspaceRoot: "/workspaces/Worker Root",
      createId: () => "nonce-xml",
    });

    expect(calls).toHaveLength(1);
    expect(filePartUrl(parts, 1)).toBe("file:///workspaces/Worker%20Root/.opencode/openwork/inbox/chat-attachments/ses_xml/nonce-xml-sitemap.xml");
    expect(parts[1]).toMatchObject({
      type: "file",
      filename: "sitemap.xml",
      mime: "text/plain",
    });
  });

  test("workspace binary attachments upload for tool access and emit a Read-mediated text/plain file part", async () => {
    const { endpoint, calls } = uploadRecorder("server-workspace-42");
    const file = new File([PPTX_BYTES], "recording.zip", { type: "application/zip" });

    const parts = await composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_bin",
      workspaceRoot: "/workspaces/Worker Root",
      createId: () => "nonce-bin",
    });

    expect(calls).toEqual([{
      workspaceId: "server-workspace-42",
      path: "chat-attachments/ses_bin/nonce-bin-recording.zip",
      filename: "recording.zip",
      bytes: Array.from(PPTX_BYTES),
    }]);
    expect(textPart(parts)).toMatchObject({ type: "text", synthetic: true });
    expect(textPartText(parts)).toContain(".opencode/openwork/inbox/chat-attachments/ses_bin/nonce-bin-recording.zip");
    expect(textPartText(parts)).toContain("Read/Bash/MCP/Docling");
    // text/plain file parts never reach the provider (opencode expands them
    // through the Read tool), so binaries keep a transcript badge safely.
    expect(filePartUrl(parts, 1)).toBe("file:///workspaces/Worker%20Root/.opencode/openwork/inbox/chat-attachments/ses_bin/nonce-bin-recording.zip");
    expect(parts[1]).toMatchObject({
      type: "file",
      filename: "recording.zip",
      mime: "text/plain",
    });
  });

  test("uploads duplicate filenames to distinct non-overwriting paths", async () => {
    const { endpoint, calls } = uploadRecorder("workspace-a");
    const first = new File([PDF_BYTES], "scan.pdf", { type: "application/pdf" });
    const second = new File([PDF_BYTES], "scan.pdf", { type: "application/pdf" });
    const ids = ["nonce-a", "nonce-b"];

    const parts = await composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(first), attachmentFor(second)],
      endpoint,
      sessionId: "ses_dupes",
      workspaceRoot: "C:\\Users\\Ada Lovelace\\工作区",
      createId: () => {
        const id = ids.shift();
        if (!id) throw new Error("missing nonce");
        return id;
      },
    });

    expect(calls.map((call) => call.path)).toEqual([
      "chat-attachments/ses_dupes/nonce-a-scan.pdf",
      "chat-attachments/ses_dupes/nonce-b-scan.pdf",
    ]);
    expect(new Set(calls.map((call) => call.path)).size).toBe(2);
    expect(filePartUrl(parts, 1)).toBe("file:///C:/Users/Ada%20Lovelace/%E5%B7%A5%E4%BD%9C%E5%8C%BA/.opencode/openwork/inbox/chat-attachments/ses_dupes/nonce-a-scan.pdf");
    expect(filePartUrl(parts, 2)).toBe("file:///C:/Users/Ada%20Lovelace/%E5%B7%A5%E4%BD%9C%E5%8C%BA/.opencode/openwork/inbox/chat-attachments/ses_dupes/nonce-b-scan.pdf");
  });

  test("fails before producing prompt parts when workspace upload fails", async () => {
    const endpoint: ChatAttachmentWorkspaceEndpoint = {
      workspaceId: "workspace-a",
      client: {
        uploadInbox: async () => {
          throw new Error("disk full");
        },
      },
    };
    const file = new File([PDF_BYTES], "scan.pdf", { type: "application/pdf" });

    await expect(composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_fail",
      workspaceRoot: "/workspace/a",
      createId: () => "nonce-a",
    })).rejects.toThrow("Failed to copy attachment \"scan.pdf\" into this worker workspace: disk full");
  });

  test("treats an ok:false upload result as a hard failure", async () => {
    const endpoint: ChatAttachmentWorkspaceEndpoint = {
      workspaceId: "workspace-a",
      client: {
        uploadInbox: async (_workspaceId, file, options) => ({
          ok: false,
          path: options?.path?.trim() || file.name,
          bytes: file.size,
        }),
      },
    };
    const file = new File([PDF_BYTES], "scan.pdf", { type: "application/pdf" });

    await expect(composerAttachmentsToWorkspaceFileParts({
      attachments: [attachmentFor(file)],
      endpoint,
      sessionId: "ses_rejected",
      workspaceRoot: "/workspace/a",
      createId: () => "nonce-a",
    })).rejects.toThrow("Failed to copy attachment \"scan.pdf\" into this worker workspace: upload was rejected");
  });
});
