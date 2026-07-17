import { describe, expect, test } from "bun:test";

import { getMediaBadge, getSafeFileDownloadUrl } from "../src/components/chat/utils";
import { getArtifactsFromMessages } from "../src/lib/artifacts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("Office attachment UI affordances", () => {
  test("uses compact Office badges instead of exposing MIME subtypes", () => {
    expect(getMediaBadge({ filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME })).toBe("DOCX");
    expect(getMediaBadge({ filename: "LaunchRoadmap.PPTX", mediaType: PPTX_MIME })).toBe("PPTX");
    expect(getMediaBadge({ filename: "LaunchRoadmap.PPTX", mediaType: "application/octet-stream" })).toBe("PPTX");
    expect(getMediaBadge({ filename: "RevenueWorkbook.XLSX", mediaType: XLSX_MIME })).toBe("XLSX");
    expect(getMediaBadge({ filename: "RevenueWorkbook.XLSX", mediaType: "" })).toBe("XLSX");
  });

  test("only exposes download actions for browser-managed file URLs", () => {
    expect(getSafeFileDownloadUrl({ url: `data:${DOCX_MIME};base64,UEsDBA==` })).toBe(`data:${DOCX_MIME};base64,UEsDBA==`);
    expect(getSafeFileDownloadUrl({ url: "blob:http://localhost/office-download" })).toBe("blob:http://localhost/office-download");
    expect(getSafeFileDownloadUrl({ url: "file:///workspace/artifacts/QuarterlyBrief.docx" })).toBeNull();
    expect(getSafeFileDownloadUrl({ url: "https://example.com/QuarterlyBrief.docx" })).toBeNull();
    expect(getSafeFileDownloadUrl({ url: "javascript:alert(1)" })).toBeNull();
  });

  test("collects DOCX artifacts as document previews", () => {
    const artifacts = getArtifactsFromMessages([
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", text: "Created artifacts/QuarterlyBrief.docx and artifacts/LaunchRoadmap.pptx." }],
      },
    ]);

    const docx = artifacts.find((artifact) => artifact.path === "artifacts/quarterlybrief.docx");
    const pptx = artifacts.find((artifact) => artifact.path === "artifacts/launchroadmap.pptx");

    expect(docx?.type).toBe("document");
    expect(docx?.legacy_target.preview).toBe("document");
    expect(pptx?.type).toBe("slides");
    expect(pptx?.legacy_target.preview).toBe("slides");
  });
});
