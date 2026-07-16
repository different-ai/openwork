import { afterEach, describe, expect, test } from "bun:test";
import { OPENWORK_OPERATION_DEADLINES } from "@openwork/types/operation-deadlines";

import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("Den-connected client timeout policy", () => {
  test("gives Cloud MCP transport enough time for the server-owned workflow", async () => {
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

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    expect(OPENWORK_OPERATION_DEADLINES.cloudMcpServerMs).toBeLessThan(
      OPENWORK_OPERATION_DEADLINES.cloudMcpTransportMs,
    );
    expect(OPENWORK_OPERATION_DEADLINES.cloudMcpTransportMs * 2 + 1_000).toBeLessThanOrEqual(
      OPENWORK_OPERATION_DEADLINES.cloudMcpSubmissionMs,
    );
  });

  test("propagates caller cancellation instead of only stopping the UI wait", async () => {
    const fetchMock: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const controller = new AbortController();
    const client = createOpenworkServerClient({ baseUrl: "https://worker.test" });
    const pending = client.getOpenworkCloudMcpHealth(
      "workspace_1",
      undefined,
      { signal: controller.signal },
    );
    controller.abort("context_changed");

    await expect(pending).rejects.toBe("context_changed");
  });
});
