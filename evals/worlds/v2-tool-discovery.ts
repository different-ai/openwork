import { randomUUID } from "node:crypto";
import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "@openwork/labs";
import type { Place, Seed } from "@openwork/env";
import { engineParity } from "./engine-parity.ts";

export async function v2ToolDiscovery(seed: Seed, options: { place: Place }) {
  const stack = new AsyncDisposableStack();
  try {
    const base = stack.use(await engineParity(seed, options));
    const nonce = `REPORT-${randomUUID()}`;
    const witness = await startMockMcp({ port: await allocateFreePort(), allowUnauthenticatedMcp: true,
      tools: [{ name: "read_report", description: "Read the discovery verification report", inputSchema: { type: "object", properties: {} },
        result: { content: [{ type: "text", text: nonce }] } }],
    });
    stack.defer(() => witness.stop());
    return { ...base, nonce, mcpUrl: witness.mcpUrl, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
