import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatJson, McpToolCallInspector, type McpToolCallOutcome } from "./tool-call-inspector";

function outcome(result: unknown, overrides: Partial<McpToolCallOutcome> = {}): McpToolCallOutcome {
  return {
    status: "completed",
    referenceId: "test-reference",
    durationMs: 10,
    result,
    inspection: null,
    failureAttribution: null,
    errorMessage: null,
    ...overrides,
  };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

test("the revised result puts the answer first and preserves the entire raw result in collapsed Technical details", () => {
  const result = {
    _meta: { serverInfo: { icons: [{ src: `data:image/png;base64,${"A".repeat(100_000)}` }] } },
    content: [{ type: "text", text: "Fallback text" }],
    structuredContent: { profile: { name: "Test user" } },
  };
  const html = renderToStaticMarkup(<McpToolCallInspector outcome={outcome(result)} />);
  const beforeDetails = html.split("<details")[0] ?? "";
  assert.match(beforeDetails, /Test user/);
  assert.doesNotMatch(beforeDetails, /base64|serverInfo|Fallback text/);
  assert.match(html, /Technical details/);
  assert.doesNotMatch(html, /<details[^>]*open=/);
  assert.ok(html.includes(escape(formatJson(result))), "the complete original remains available");
  assert.doesNotMatch(html, /<img|<iframe|<audio|<video/);
  assert.match(html, /Credential headers redacted/);
  assert.match(html, /never stored in OpenWork logs/);
});

test("text is escaped rather than rendered as HTML or used as an image source", () => {
  const html = renderToStaticMarkup(<McpToolCallInspector outcome={outcome({ content: [{ type: "text", text: '<img src="https://example.test/logo.png" />' }] })} />);
  assert.match(html.split("<details")[0] ?? "", /&lt;img/);
  assert.doesNotMatch(html, /<img|<link[^>]*preload/);
});

test("empty and image-only outcomes stay inspectable without exposing binary data first", () => {
  for (const result of [null, { content: [] }, { content: [{ type: "image", data: "binary-payload" }] }]) {
    const html = renderToStaticMarkup(<McpToolCallInspector outcome={outcome(result)} />);
    assert.match(html, /Technical details/);
    assert.match(html.split("<details")[0] ?? "", /No (readable text|result content) was returned/);
    assert.doesNotMatch(html.split("<details")[0] ?? "", /binary-payload/);
    assert.ok(html.includes(escape(formatJson(result))));
  }
});

test("failures retain their status, useful message and full diagnostics", () => {
  const result = { error: "Connection failed", diagnostic: { referenceId: "diagnostic-reference" } };
  const html = renderToStaticMarkup(<McpToolCallInspector outcome={outcome(result, { status: "failed", errorMessage: "Connection failed" })} />);
  const beforeDetails = html.split("<details")[0] ?? "";
  assert.match(beforeDetails, /Tool call failed/);
  assert.match(beforeDetails, /Connection failed/);
  assert.doesNotMatch(beforeDetails, /diagnostic-reference/);
  assert.ok(html.includes(escape(formatJson(result))));
});
