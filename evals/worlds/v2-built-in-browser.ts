import { resolveEvalEngine, startBrowserFixture } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { builtinBrowserWorld } from "./browser-panel.ts";

export async function v2BuiltInBrowser(seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  try {
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    const workspacePath = seed.tmpPath("v2-browser");
    await mkdir(workspacePath, { recursive: true });
    // Keep the native starter model, replacing only its paid transport before
    // the engine boots. No model switching or browser approval is seeded.
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ provider: { opencode: {
      npm: "@ai-sdk/openai-compatible", options: { baseURL: `${mock.url}/v1`, apiKey: "browser-fixture-only" },
      whitelist: ["big-pickle"], models: { "big-pickle": { name: "Big Pickle", tool_call: true,
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` } } },
    } } }));
    const base = await builtinBrowserWorld(seed, { workspacePath });
    const fixture = stack.use(await startBrowserFixture(base.app, { requireSignIn: false }));
    return { ...base, engine: resolveEvalEngine(), pageOrigin: fixture.origin,
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }] }) });
        if (!response.ok) throw new Error("The browser model workload could not be configured");
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
