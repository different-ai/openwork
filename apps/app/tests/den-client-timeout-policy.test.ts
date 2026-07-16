import { afterEach, describe, expect, test } from "bun:test";

import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("Den-connected client timeout policy", () => {
  test("leaves Cloud MCP health and repair deadlines to the owning server", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      signals.push(init?.signal);
      return Response.json({ usable: true });
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const client = createOpenworkServerClient({ baseUrl: "https://worker.test" });
    await client.getOpenworkCloudMcpHealth("workspace_1");
    await client.reconcileOpenworkCloudMcp("workspace_1", {
      workspaceId: "workspace_1",
      name: "openwork-cloud",
      config: { type: "remote", url: "https://den.test/mcp/agent" },
    });

    expect(signals).toEqual([undefined, undefined]);
  });
});
