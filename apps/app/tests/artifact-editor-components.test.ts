import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("artifact editor components", () => {
  test("keeps Markdown live preview while delegating every edit to autosave", () => {
    const textEditor = source("../src/react-app/domains/session/artifacts/artifact-text-editor.tsx");
    const panel = source("../src/react-app/domains/session/artifacts/artifact-panel.tsx");

    expect(textEditor).toContain("markdownLivePreview()");
    expect(panel).toContain("autosave.edit({ kind: \"text\", data: value })");
    expect(panel).not.toMatch(/>\s*(?:Save|Discard)\s*</);
  });

  test("keeps spreadsheet format support and removes manual persistence controls", () => {
    const editor = source("../src/react-app/domains/session/artifacts/artifact-spreadsheet-editor.tsx");
    const model = source("../src/react-app/domains/session/artifacts/artifact-spreadsheet-model.ts");
    const panel = source("../src/react-app/domains/session/artifacts/artifact-panel.tsx");

    expect(editor).toContain("SpreadsheetSource");
    expect(editor).toContain("onChangeRef.current(next)");
    expect(editor).not.toContain("serializeSpreadsheet");
    expect(panel).toContain("await serializeSpreadsheet(target.name, payload.rows)");
    expect(editor).not.toMatch(/>\s*(?:Save|Discard)\s*</);
    expect(model).toContain('ext === "csv" || ext === "tsv"');
    expect(model).toContain('ext === "xls" ? "xls" : ext === "ods" ? "ods" : "xlsx"');
  });

  test("renders persistent conflict recovery choices in the shared panel", () => {
    const panel = source("../src/react-app/domains/session/artifacts/artifact-panel.tsx");

    expect(panel).toContain("This file changed outside OpenWork");
    expect(panel).toContain("Reload external version");
    expect(panel).toContain("Retry newest changes");
  });

  test("protects retained target drafts and reads binary baselines authoritatively", () => {
    const panel = source("../src/react-app/domains/session/artifacts/artifact-panel.tsx");

    expect(panel).toContain("dirtyAutosaves");
    expect(panel).toContain("flushRetainedAutosaves()");
    expect(panel).toContain("before.updatedAt !== after.updatedAt");
    expect(panel).toContain("updatedAt: after.updatedAt ?? null");
    expect(panel).toContain('key={`${workspaceId}:${target.id}`}');
  });
});
