import assert from "node:assert/strict";
import { test } from "node:test";
import { toolResultPresentation } from "./result-presentation";

test("structured content wins over mixed text, images and large server metadata without mutating raw data", () => {
  const result = {
    _meta: { serverInfo: { icons: [{ src: `data:image/png;base64,${"A".repeat(100_000)}` }] } },
    content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "fallback" }],
    structuredContent: { profile: { name: "Test user" } },
  };
  const raw = JSON.stringify(result);
  const presentation = toolResultPresentation(result);
  assert.deepEqual(presentation.blocks, [{ kind: "json", text: JSON.stringify(result.structuredContent, null, 2) }]);
  assert.equal(presentation.isError, false);
  assert.equal(presentation.emptyMessage, null);
  assert.equal(JSON.stringify(result), raw);
  assert.doesNotMatch(presentation.blocks[0]?.text ?? "", /base64|serverInfo|fallback/);
});

test("text blocks keep their order, parse JSON for display only and ignore binary content", () => {
  const result = {
    _meta: { serverInfo: { name: "Metadata" } },
    content: [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: '{"count":2}' },
      { type: "text", text: "Readable result" },
      { type: "audio", data: "BBBB", mimeType: "audio/wav" },
      { type: "text", text: "  " },
      { type: "text", text: "{invalid JSON}" },
    ],
  };
  assert.deepEqual(toolResultPresentation(result).blocks, [
    { kind: "json", text: '{\n  "count": 2\n}' },
    { kind: "text", text: "Readable result" },
    { kind: "text", text: "{invalid JSON}" },
  ]);
  assert.equal(result.content[1]?.text, '{"count":2}');
});

test("empty structured content falls back to readable text, but false and zero remain meaningful", () => {
  for (const structuredContent of [null, {}, [], " "]) {
    assert.deepEqual(toolResultPresentation({ structuredContent, content: [{ type: "text", text: "Answer" }] }).blocks,
      [{ kind: "text", text: "Answer" }]);
  }
  for (const structuredContent of [false, 0]) {
    assert.deepEqual(toolResultPresentation({ structuredContent }).blocks,
      [{ kind: "json", text: JSON.stringify(structuredContent) }]);
  }
});

test("empty and image/binary-only results direct people to the complete diagnostic result", () => {
  for (const result of [null, undefined, {}, { content: [] }, { content: [{ type: "text", text: "" }] }]) {
    assert.deepEqual(toolResultPresentation(result).blocks, []);
    assert.match(toolResultPresentation(result).emptyMessage ?? "", /Technical details/);
  }
  const result = { content: [{ type: "image", data: "AAAA" }, { type: "resource", resource: { blob: "BBBB" } }] };
  const presentation = toolResultPresentation(result);
  assert.deepEqual(presentation.blocks, []);
  assert.match(presentation.emptyMessage ?? "", /No readable text/);
});

test("MCP failures keep their error content and locally generated errors omit diagnostics from the answer", () => {
  const mcp = toolResultPresentation({ isError: true, content: [{ type: "text", text: "Permission denied" }] });
  assert.equal(mcp.isError, true);
  assert.equal(mcp.blocks[0]?.text, "Permission denied");
  const local = toolResultPresentation({ error: "Connection failed", diagnostic: { referenceId: "test-reference" } });
  assert.equal(local.isError, true);
  assert.deepEqual(local.blocks, [{ kind: "text", text: "Connection failed" }]);
  assert.equal(toolResultPresentation({ isError: true }).isError, true);
});

test("plain string results are readable, including valid JSON primitives", () => {
  assert.deepEqual(toolResultPresentation("A result").blocks, [{ kind: "text", text: "A result" }]);
  assert.deepEqual(toolResultPresentation({ content: [{ type: "text", text: "null" }] }).blocks, [{ kind: "json", text: "null" }]);
});
