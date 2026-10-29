import assert from "node:assert/strict";
import { test } from "node:test";
import contextPlugin from "../src/opencode-plugins/openwork-context-v2.js";
import { addProviderSafeTool, providerSchemaProblems } from "../src/opencode-plugins/provider-safe-tool-schema.js";

type Registered = { name: string; input: Record<string, unknown> };

// Loads the context plugin the way OpenCode v2 does, with the browser and
// computer enabled, and returns every tool it registers.
async function registeredTools() {
  const tools: Registered[] = [];
  const registration = { dispose: async () => {} };
  const dispose = await contextPlugin.setup({
    options: { url: "http://127.0.0.1:9/context", token: "context", browser: { url: "http://127.0.0.1:9/browser", token: "browser" } },
    tool: { transform: async (callback: (editor: { add(tool: Registered): void }) => void) => { callback({ add: tool => tools.push(tool) }); return registration; } },
    skill: { transform: async () => registration, reload: async () => {} },
  } as unknown as Parameters<typeof contextPlugin.setup>[0]);
  await dispose();
  return tools;
}

test("every OpenWork tool on OpenCode v2 sends a schema providers accept", async () => {
  const tools = await registeredTools();
  for (const name of ["openwork_context", "openwork_drive_upload", "openwork_gmail_draft", "openwork_outlook_draft", "browser_act", "computer_run", "computer_act"]) assert.ok(tools.some(tool => tool.name === name), name);
  for (const tool of tools) assert.deepEqual(providerSchemaProblems(tool.input), [], tool.name);
});

test("schemas providers reject are named", () => {
  assert.deepEqual(providerSchemaProblems({ type: "object", properties: { input: { $ref: "#/$defs/json" } }, $defs: { json: {} } }), ["$ref at /properties/input"]);
  assert.deepEqual(providerSchemaProblems({ type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] }), ["top-level anyOf"]);
  assert.deepEqual(providerSchemaProblems({ type: "object", properties: { raw: { type: "string", maxLength: 5_000_000 } } }), ["maxLength 5000000 at /properties/raw"]);
  assert.deepEqual(providerSchemaProblems({ type: "array", items: {} }), ["the root is not an object schema"]);
  // Property names are data, not keywords.
  assert.deepEqual(providerSchemaProblems({ type: "object", properties: { $ref: { type: "string" }, maxLength: { type: "number" } } }), []);
});

test("a tool providers would reject is left out instead of failing every request", () => {
  const added: string[] = [];
  const editor = { add: (tool: { name: string }) => added.push(tool.name) };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(addProviderSafeTool(editor, { name: "recursive", input: { type: "object", properties: { input: { $ref: "#" } } } }), false);
    assert.equal(addProviderSafeTool(editor, { name: "flat", input: { type: "object", properties: { input: {} } } }), true);
  } finally { console.warn = warn; }
  assert.deepEqual(added, ["flat"]);
});
