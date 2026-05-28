import assert from "node:assert/strict";
import test from "node:test";

import { parseOpencodeConfig } from "./opencode-config-json.mjs";

test("parseOpencodeConfig accepts commented opencode.jsonc", () => {
  assert.deepEqual(
    parseOpencodeConfig(`{
      // Browser MCP entries are seeded into commented configs.
      "mcp": {
        "existing": { "type": "remote", "url": "http://127.0.0.1:1/mcp" },
      },
    }`),
    {
      mcp: {
        existing: { type: "remote", url: "http://127.0.0.1:1/mcp" },
      },
    },
  );
});

test("parseOpencodeConfig rejects invalid config text", () => {
  assert.throws(() => parseOpencodeConfig("// only a comment"), /Invalid OpenCode config JSON\/JSONC/);
});
