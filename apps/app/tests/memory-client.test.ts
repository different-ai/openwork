import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";
import { byCreatedAtDesc, restoreMemory } from "../src/react-app/domains/settings/pages/memory-view";
import type { DenMemory } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (input: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return handler(url, init ?? undefined);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  return calls;
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

const client = () =>
  createDenClient({ baseUrl: "https://web.test", apiBaseUrl: "https://api.test", token: "tok_test" });

describe("Den memory client", () => {
  test("listMemory normalizes memories, tags, and contexts and drops malformed rows", async () => {
    const calls = mockFetch((url) => {
      expect(url).toContain("/v1/memory");
      return new Response(
        JSON.stringify({
          memories: [
            {
              id: "mem_1",
              content: "deploys via daytona",
              tags: ["deploy", 5, "infra"],
              source: "chat",
              scope: "user",
              createdAt: "2026-07-02T00:00:00.000Z",
              updatedAt: "2026-07-02T00:00:00.000Z",
              contexts: [
                { id: "mctx_1", snippet: "we agreed on the plan", origin: "active_conversation", citation: { conversation_id: "c1" }, createdAt: "2026-07-02T00:00:00.000Z" },
                { id: 42, snippet: "bad id dropped" },
              ],
            },
            { id: "mem_bad" }, // missing content -> dropped
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const memories = await client().listMemory("org_1");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.id).toBe("mem_1");
    expect(memories[0]?.tags).toEqual(["deploy", "infra"]); // non-string tag filtered out
    expect(memories[0]?.contexts).toHaveLength(1); // malformed context dropped
    expect(memories[0]?.contexts[0]?.citation).toEqual({ conversation_id: "c1" });
    expect(calls[0]?.method).toBe("GET");
  });

  test("listMemory returns [] on a non-array payload", async () => {
    mockFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await client().listMemory("org_1")).toEqual([]);
  });

  test("deleteMemory issues a DELETE and resolves on 204", async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    await client().deleteMemory("org_1", "mem_1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/memory/mem_1");
  });

  test("deleteMemory treats 404 as success (idempotent)", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "memory_not_found" }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(client().deleteMemory("org_1", "mem_gone")).resolves.toBeUndefined();
  });

  test("deleteMemory throws on a real server error", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
    await expect(client().deleteMemory("org_1", "mem_1")).rejects.toThrow();
  });
});

describe("Memory panel optimistic-undo logic", () => {
  const mk = (id: string, createdAt: string): DenMemory => ({
    id,
    content: id,
    tags: null,
    source: "chat",
    scope: "user",
    createdAt,
    updatedAt: createdAt,
    contexts: [],
  });

  test("restoreMemory re-inserts a removed memory newest-first without duplicating", () => {
    const a = mk("mem_a", "2026-07-01T00:00:00.000Z");
    const b = mk("mem_b", "2026-07-03T00:00:00.000Z");
    const c = mk("mem_c", "2026-07-02T00:00:00.000Z");
    // b was optimistically removed; the remaining list is [c, a] (newest-first).
    const afterRemove = [c, a];
    const restored = restoreMemory(afterRemove, b);
    expect(restored.map((m) => m.id)).toEqual(["mem_b", "mem_c", "mem_a"]);
    // Restoring again does not duplicate.
    expect(restoreMemory(restored, b).filter((m) => m.id === "mem_b")).toHaveLength(1);
  });

  test("restoreMemory tolerates an undefined cache", () => {
    const a = mk("mem_a", "2026-07-01T00:00:00.000Z");
    expect(restoreMemory(undefined, a).map((m) => m.id)).toEqual(["mem_a"]);
  });

  test("byCreatedAtDesc orders newest first", () => {
    const older = mk("older", "2026-07-01T00:00:00.000Z");
    const newer = mk("newer", "2026-07-05T00:00:00.000Z");
    expect([older, newer].sort(byCreatedAtDesc).map((m) => m.id)).toEqual(["newer", "older"]);
  });
});
