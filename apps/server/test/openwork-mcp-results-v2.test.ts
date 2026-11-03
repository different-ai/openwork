import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { PINNED_CONNECT_TOOL_IDS } from "../src/opencode-plugins/openwork-mcp-results-v2.js";
import { mcpToolId } from "../src/opencode-v2-mcp-readiness.js";

type Tool = { options?: Record<string, unknown>; execute(input: unknown, call: unknown): Promise<{ output?: unknown }> };

function engine(ids: readonly string[]) {
  const tools = new Map<string, Tool>(ids.map(id => [id, {
    options: { namespace: id.split("_")[0], codemode: true },
    execute: async () => ({ output: id }),
  }]));
  const registration = { async dispose() {} };
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
      async hook() { return registration; },
    },
  };
  return { tools, context };
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
