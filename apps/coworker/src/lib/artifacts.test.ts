import assert from "node:assert/strict";
import test from "node:test";
import { artifactKindLabel, artifactsForToolCall } from "./artifacts.ts";

test("browser tools present a URL as a browser artifact", () => {
  assert.deepEqual(
    artifactsForToolCall({
      tool: "browser_navigate",
      input: { url: "https://example.com/reports/weekly" },
      output: { title: "Weekly report" },
      metadata: {},
    }),
    [{
      kind: "browser",
      label: "example.com",
      value: "https://example.com/reports/weekly",
      openUrl: "https://example.com/reports/weekly",
    }],
  );
});

test("artifact payloads distinguish common work formats and stay bounded", () => {
  assert.deepEqual(
    artifactsForToolCall({
      tool: "save_artifacts",
      input: {},
      output: {
        files: [
          { path: "reports/forecast.xlsx" },
          { path: "briefs/launch.docx" },
          { path: "decks/review.pptx" },
          { path: "ignored/fourth.pdf" },
        ],
      },
      metadata: {},
    }).map(({ kind, label }) => ({ kind, label })),
    [
      { kind: "sheet", label: "forecast.xlsx" },
      { kind: "document", label: "launch.docx" },
      { kind: "slides", label: "review.pptx" },
    ],
  );
});

test("ordinary prose and unrelated URLs are not promoted to artifacts", () => {
  assert.deepEqual(artifactsForToolCall({
    tool: "search_capabilities",
    input: { query: "open https://example.com later" },
    output: { summary: "Created no files." },
    metadata: {},
  }), []);
  assert.equal(artifactKindLabel("pdf"), "PDF");
});
