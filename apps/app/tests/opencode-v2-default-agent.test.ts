import { afterEach, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const agents = [
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
];

// A v2 engine that keeps each chat on the last agent it was switched to.
function engine(initialAgent: string) {
  let agent = initialAgent;
  const switches: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/agent")) return Response.json({ location: {}, data: agents });
      if (path.endsWith("/agent") && request.method === "POST") {
        const body: unknown = await request.json();
        const next = body && typeof body === "object" ? Reflect.get(body, "agent") : undefined;
        if (typeof next === "string") {
          agent = next;
          switches.push(next);
        }
        return Response.json({ location: {}, data: {} });
      }
      if (request.method === "GET" && path.endsWith("/api/session/ses_1")) {
        return Response.json({ location: {}, data: { id: "ses_1", agent } });
      }
      return new Response(null, { status: 204 });
    },
  });
  return { agent: () => agent, switches };
}

function send(client: ReturnType<typeof createClientV2>, agent?: string) {
  return client.session.promptAsync({
    sessionID: "ses_1",
    model: { providerID: "anthropic", modelID: "claude" },
    parts: [{ type: "text", text: "hello" }],
    ...(agent ? { agent } : {}),
  });
}

test("choosing Default after Plan moves the chat back to the default agent", async () => {
  const state = engine("build");
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  expect((await send(client, "plan")).error).toBeUndefined();
  expect(state.agent()).toBe("plan");
  expect((await send(client)).error).toBeUndefined();
  expect(state.agent()).toBe("build");
  expect((await send(client, "plan")).error).toBeUndefined();
  expect(state.switches).toEqual(["plan", "build", "plan"]);
});

test("a chat already on Plan in the engine leaves it when Default is sent", async () => {
  const state = engine("plan");
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  expect((await send(client)).error).toBeUndefined();
  expect(state.agent()).toBe("build");
  expect((await send(client)).error).toBeUndefined();
  expect(state.switches).toEqual(["build"]);
});

test("a sub-agent's own chat keeps its agent", async () => {
  const state = engine("explore");
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  expect((await send(client)).error).toBeUndefined();
  expect(state.agent()).toBe("explore");
  expect(state.switches).toEqual([]);
});

test("an agent the engine does not define runs on the default agent", async () => {
  const state = engine("openwork");
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  expect((await send(client)).error).toBeUndefined();
  expect(state.agent()).toBe("build");
});
