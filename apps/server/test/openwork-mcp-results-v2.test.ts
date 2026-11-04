import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeDiscoveryCode } from "../src/opencode-plugins/openwork-codemode-discovery-v2.js";
import plugin, { PINNED_CONNECT_TOOL_IDS } from "../src/opencode-plugins/openwork-mcp-results-v2.js";
import { mcpToolId } from "../src/opencode-v2-mcp-readiness.js";

type Tool = { options?: Record<string, unknown>; execute(input: unknown, call: unknown): Promise<{ output?: unknown }> };

function engine(ids: readonly string[]) {
  const tools = new Map<string, Tool>(ids.map(id => [id, {
    options: { namespace: id.split("_")[0], codemode: true },
    execute: async () => ({ output: id }),
  }]));
  const registration = { async dispose() {} };
  const hooks = new Map<string, (event: { tool: string; messageID: string; id: string; input: unknown }) => void>();
  const context = {
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({
          get: (id: string) => tools.get(id),
          list: () => [...tools.keys()].map(id => ({ id })),
          // The engine hands the callback a copy and keeps what it returns.
          update(id: string, change: (tool: Tool) => void) {
            const current = tools.get(id);
            if (!current) return;
            const copy = { ...current, options: current.options && { ...current.options } };
            change(copy);
            tools.set(id, copy);
          },
        });
        return registration;
      },
      async hook(name: string, callback: (event: { tool: string; messageID: string; id: string; input: unknown }) => void) {
        hooks.set(name, callback);
        return registration;
      },
    },
  };
  return { tools, context, hooks };
}

test("Connect's search, execute, and skill reader stay pinned in the Code Mode catalog", async () => {
  const connect = (name: string) => mcpToolId("openwork-cloud", name);
  const ids = [connect("search_capabilities"), connect("execute_capability"), connect("get_skill"), connect("create_app"),
    mcpToolId("github", "search_capabilities"), "execute"];
  const native = engine(ids);
  await plugin.setup(native.context as never);

  const pinned = ids.filter(id => native.tools.get(id)?.options?.pinned === true);
  assert.deepEqual(pinned, [connect("search_capabilities"), connect("execute_capability"), connect("get_skill")]);
  assert.deepEqual([...PINNED_CONNECT_TOOL_IDS].sort(), [...pinned].sort());
  // Pinning keeps the engine's own options and still runs the tool.
  assert.equal(native.tools.get(connect("search_capabilities"))?.options?.codemode, true);
  const call = { messageID: "m", id: "c", progress: async () => {} };
  assert.deepEqual(await native.tools.get(connect("search_capabilities"))?.execute({}, call), { output: connect("search_capabilities") });
});

test("a server's spelling of search runs the engine's search", () => {
  assert.equal(nativeDiscoveryCode('const r = await tools["openwork-cloud"].search({ query: "app" });'), 'const r = await search({ query: "app" });');
  assert.equal(nativeDiscoveryCode('return tools.github["search"]({ query: "x" })'), 'return search({ query: "x" })');
  assert.equal(nativeDiscoveryCode("return tools.search({ query: 'x' })"), "return search({ query: 'x' })");
  // A server's real search tool, other tools, strings, and shadowed names stay.
  const own = 'return tools.github.search({ q: "x" })';
  assert.equal(nativeDiscoveryCode(own, server => server === "github"), own);
  const other = 'return tools["openwork-cloud"].search_capabilities({ query: "search" })';
  assert.equal(nativeDiscoveryCode(other), other);
  const shadowed = 'const tools = { a: { search: () => 1 } }; return tools.a.search()';
  assert.equal(nativeDiscoveryCode(shadowed), shadowed);
});

test("Code Mode keeps a server's own search tool and rewrites the missing one", async () => {
  const native = engine([mcpToolId("openwork-cloud", "search_capabilities"), mcpToolId("github", "search"), "execute"]);
  await plugin.setup(native.context as never);
  const run = (code: string) => {
    const event = { tool: "execute", messageID: "m", id: "c", input: { code } as unknown };
    native.hooks.get("execute.before")?.(event);
    return (event.input as { code: string }).code;
  };
  assert.equal(run('await tools["openwork-cloud"].search({ query: "app" })'), 'await search({ query: "app" })');
  assert.equal(run('await tools.github.search({ q: "x" })'), 'await tools.github.search({ q: "x" })');
});
