import { afterEach, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// A v1 chat archived before the engine upgrade keeps its archive time in v2,
// but v2 has no unarchive. It must open as an active chat, never read-only (#6367).
test("a v2 session with a copied v1 archive time is active", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({ location: { directory: "/tmp/ws" }, data: {
      id: "ses_1", title: "Archived in v1", time: { created: 1, updated: 2, archived: 3 },
    } }),
  });
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  const result = await client.session.get({ sessionID: "ses_1" });
  expect(result.error).toBeUndefined();
  expect(result.data?.time).toEqual({ created: 1, updated: 2 });
});
