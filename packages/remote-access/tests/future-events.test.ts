import { test, expect } from "vitest";
import { EventHub } from "../src/events/hub.js";
test("the running hub subscribes to projects added after startup without duplicating subscriptions", async () => {
  let workspaces = [{ id: "one", name: "One" }];
  const subscriptions: string[] = [];
  const adapter: any = {
    health: async () => {},
    listWorkspaces: async () => workspaces,
    subscribe: async (w: string, signal: AbortSignal) => {
      subscriptions.push(w);
      return new Response(
        new ReadableStream({
          start(c) {
            signal.addEventListener("abort", () => c.close(), { once: true });
          },
        }),
      );
    },
  };
  const hub = new EventHub(adapter);
  try {
    await hub.start();
    await new Promise((r) => setTimeout(r, 0));
    workspaces.push({ id: "two", name: "Two" });
    await (hub as any).refreshWorkspaces();
    await new Promise((r) => setTimeout(r, 0));
    await (hub as any).refreshWorkspaces();
    expect(subscriptions).toEqual(["one", "two"]);
  } finally {
    await hub.close();
  }
});
