import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";
import { visibleMemories } from "../src/react-app/domains/settings/pages/memory-utils";
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
  createDenClient({ baseUrl: "https://web.test", token: "tok_test" });

describe("Den memory client", () => {
  test("listMemory normalizes memories, tags, and contexts and drops malformed rows", async () => {
    const calls = mockFetch((url) => {
      expect(url).toContain("/api/den/v1/memory");
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

describe("Memory panel optimistic-delete veil", () => {
  const mk = (id: string): DenMemory => ({
    id,
    content: id,
    tags: null,
    source: "chat",
    scope: "user",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    contexts: [],
  });

  test("visibleMemories hides ids that are pending an optimistic delete, preserving order", () => {
    const list = [mk("mem_a"), mk("mem_b"), mk("mem_c")];
    expect(visibleMemories(list, new Set(["mem_b"])).map((m) => m.id)).toEqual(["mem_a", "mem_c"]);
  });

  test("visibleMemories returns the full list when nothing is pending", () => {
    const list = [mk("mem_a"), mk("mem_b")];
    expect(visibleMemories(list, new Set()).map((m) => m.id)).toEqual(["mem_a", "mem_b"]);
  });

  test("a refetch that re-includes a pending-deleted id keeps it hidden (no zombie row)", () => {
    // Simulates a background refetch bringing mem_b back while its server delete is deferred.
    const refetched = [mk("mem_a"), mk("mem_b"), mk("mem_c")];
    expect(visibleMemories(refetched, new Set(["mem_b"])).some((m) => m.id === "mem_b")).toBe(false);
  });
});
