import { engineSessionProbe } from "@openwork/behaviors";
import { resolveEvalEngine, startBrowserFixture } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { configureProvider } from "./chat.ts";

const PROVIDER = "browser-witness";
const MODEL = "browser-witness-model";

/**
 * A desktop conversation whose model is a witness: it makes the browser tool
 * calls a turn scripts, through the real engine and the shipped browser tools,
 * and records every model request it receives.
 */
export async function browserFastPath(seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  try {
    const engine = resolveEvalEngine();
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    const app = await seed.desktop({ name: "browser-fast-path" });
    const workspace = await seed.workspace(app, seed.tmpPath("browser-fast-path"), { create: true });
    await configureProvider(seed, app, workspace.workspaceId, PROVIDER, MODEL, {
      provider: { [PROVIDER]: {
        npm: "@ai-sdk/openai-compatible", name: "Browser witness",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-browser-fast-path-eval-only" },
        models: { [MODEL]: { name: "Browser witness", tool_call: true } },
      } },
    }, engine);
    const fixture = stack.use(await startBrowserFixture(app, { requireSignIn: false }));
    const session = await seed.session(app, { title: "Application form" });
    const native = engineSessionProbe({ engine, surface: app, workspaceId: workspace.workspaceId });
    return {
      app, engine, session, origin: fixture.origin,
      /** The witness model runs these tool calls when it sees the prompt, then replies. */
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }] }),
        });
        if (!response.ok) throw new Error("The browser witness workload could not be configured");
      },
      /** Model requests the engine sent for the turn with this prompt (tool rounds and the final answer). */
      async modelCalls(promptMarker: string) {
        const requests = await mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
        return requests.filter((request) => request.kind === "tool" || request.kind === "final");
      },
      /** The engine's own record of this conversation's settled browser tool calls, oldest first. */
      async browserCalls() {
        const snapshot = await native.snapshot(session.sessionId);
        if (!snapshot.ok || !snapshot.data) return [];
        return snapshot.data.messages.flatMap((message) => message.parts)
          .filter((part) => typeof part.tool === "string" && part.tool.startsWith("browser_") && ["completed", "error"].includes(part.status));
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
