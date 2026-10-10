import { expect, test } from "vitest";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { waitForMcpBindings } from "../../apps/server/src/opencode-plugins/openwork-mcp-readiness-v2.js";
import { mcpBindingsReady, mcpToolId, type McpPublishedTool } from "../../apps/server/src/opencode-v2-mcp-readiness.js";

type Tools = Parameters<typeof waitForMcpBindings>[0];
const server = "reload-witness";
const id = mcpToolId(server, "read_report");
const witness = { id, options: { namespace: server } };

function registry(initial: readonly McpPublishedTool[] = []) {
  let current = initial;
  let reads = 0;
  let disposals = 0;
  let rebuilding = false;
  let registered = () => {};
  const registration = new Promise<void>(resolve => { registered = resolve; });
  const observers = new Set<() => void>();
  const publish = (next: readonly McpPublishedTool[]) => {
    rebuilding = true;
    // Observer registration order can precede the MCP source transform.
    for (const observe of observers) observe();
    current = next;
    rebuilding = false;
  };
  const tools: Tools = {
    list: () => Effect.sync(() => {
      expect(rebuilding, "reads cannot recurse inside native registry replay").toBe(false);
      reads++;
      return current;
    }),
    reload: () => Effect.sync(() => publish(current)),
    transform: observe => Effect.acquireRelease(Effect.sync(() => {
      observers.add(observe);
      publish(current);
      registered();
      return { dispose: Effect.sync(() => {
        if (!observers.delete(observe)) return;
        disposals++;
        publish(current);
      }) };
    }), registration => registration.dispose),
  };
  return { tools, registration, publish, counts: () => ({ reads, disposals, observers: observers.size }) };
}

test("an authoritative zero-tool catalog needs no executable observer", async () => {
  const native = registry();
  await Effect.runPromise(waitForMcpBindings(native.tools, server, [], []).pipe(Effect.scoped));
  expect(native.counts()).toEqual({ reads: 1, disposals: 0, observers: 0 });
});

test("native readiness observes newly executable bindings after the complete replay", async () => {
  const native = registry();
  let completed = false;
  const ready = Effect.runPromise(waitForMcpBindings(native.tools, server, [id], []).pipe(Effect.scoped))
    .then(() => { completed = true; });
  await native.registration;
  await Promise.resolve();
  expect(completed).toBe(false);
  native.publish([witness]);
  await ready;
  expect(native.counts().disposals).toBe(1);
  expect(native.counts().observers).toBe(0);
});

test("removal waits for the old binding to leave the executable registry", async () => {
  const native = registry([witness]);
  let completed = false;
  const ready = Effect.runPromise(waitForMcpBindings(native.tools, server, [], [id]).pipe(Effect.scoped))
    .then(() => { completed = true; });
  await native.registration;
  await Promise.resolve();
  expect(completed).toBe(false);
  native.publish([]);
  await ready;
  expect(native.counts().disposals).toBe(1);
  expect(native.counts().observers).toBe(0);
});

test("an unrelated namespace cannot satisfy native MCP readiness", () => {
  expect(mcpBindingsReady([{ id, options: { namespace: "builtin" } }], server, [id], [])).toBe(false);
  expect(mcpBindingsReady([witness], server, [id], [id])).toBe(true);
  expect(mcpToolId("server.with.dots", "tool/with/dots")).toBe("server_with_dots_tool_with_dots");
});

test("cancellation disposes the observer and prevents late native registry reads", async () => {
  const native = registry();
  const controller = new AbortController();
  const ready = Effect.runPromise(waitForMcpBindings(native.tools, server, [id], []).pipe(Effect.scoped), { signal: controller.signal });
  const rejected = expect(ready).rejects.toThrow();
  await native.registration;
  controller.abort();
  await rejected;
  expect(native.counts().disposals).toBe(1);
  expect(native.counts().observers).toBe(0);
  const reads = native.counts().reads;
  native.publish([witness]);
  await Promise.resolve();
  expect(native.counts().reads).toBe(reads);
});
