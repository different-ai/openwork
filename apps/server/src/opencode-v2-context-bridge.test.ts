import { expect, test } from "bun:test";
import { createV2ContextBridge } from "./opencode-v2-context-bridge.js";

test("native read capability is authenticated, isolated, and never offers commands", async () => {
  const requests: string[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    requests.push(path);
    if (path === "/experimental/connect/skills") return { skills: [] };
    if (path === "/experimental/ui-control/request") {
      const body: unknown = JSON.parse(String(init?.body));
      if (body && typeof body === "object" && "kind" in body && body.kind === "context") return {
        ok: true, context: { screen: "session", availableAffordances: [
          { id: "screen.read", kind: "query" }, { id: "screen.change", kind: "command" },
        ] },
      };
      return { ok: false, error: "Unknown read" };
    }
    throw new Error("Unexpected host request");
  });
  try {
    expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect(requests).toHaveLength(0);
    const call = (name: string) => fetch(bridge.url, { method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input: {} }),
    });
    expect((await call("openwork_execute")).status).toBe(400);
    expect(requests).toHaveLength(0);
    const result = await call("openwork_context");
    expect(result.status).toBe(200);
    const context = await result.text();
    expect(context).toContain("screen.read");
    expect(context).toContain("session.search");
    expect(context).toContain("session.read");
    expect(context).not.toContain("screen.change");
    expect(context).not.toContain('"kind":"command"');
    expect(context).not.toContain(bridge.token);
  } finally { await bridge.close(); }
});
