import { browserScript } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { resolveEvalEngine } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function conversationNavigation(seed: Seed, { place }: { place: Place }) {
  const engine = resolveEvalEngine();
  const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
  try {
    const app = await seed.desktop({ name: "conversation-navigation" });
    const one = await seed.workspace(app, seed.tmpPath("navigation-one"), { create: true });
    const providerId = "navigation-fixture";
    const modelId = "navigation-model";
    await configureProvider(seed, app, one.workspaceId, providerId, modelId, {
      provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Navigation fixture",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-navigation-fixture-only" },
        models: { [modelId]: { name: "Navigation model" } } } },
    }, engine);
    const [a, b, c] = await seed.sessions(app, ["Navigation A", "Navigation B", "Navigation C"]);
    if (!a || !b || !c) throw new Error("Navigation sessions were not created");
    const two = await seed.workspace(app, seed.tmpPath("navigation-two"), { create: true });
    const d = await seed.session(app, { title: "Navigation D" });
    const route = (workspaceId: string, sessionId: string) => `/workspace/${workspaceId}/session/${sessionId}`;
    const links = `[Navigation B](${route(one.workspaceId, b.sessionId)})\n\n[Navigation D](${route(two.workspaceId, d.sessionId)})\n\n[Navigation A](${route(one.workspaceId, a.sessionId)})`;
    const prepared = await fetch(`${mock.url}/admin/agent-workloads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: "navigation-links-fixture", latestUserTurn: true, finalReply: links, steps: [] }] }),
    });
    if (!prepared.ok) throw new Error("Navigation model witness was not prepared");
    // TODO(primitive): seed one real model turn through an owned engine.
    // The witness produces markdown, never HTML or a navigation implementation.
    const stored = await seed.evalIn(app, browserScript(async (workspaceId, otherWorkspaceId, sessionId, engine, text, providerID, modelID) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const path = engine === "v2" ? "opencode2/api" : "opencode";
      const base = `http://127.0.0.1:${port}/workspace/${workspaceId}/${path}/session/${sessionId}`;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      for (const [id, displayName] of [[workspaceId, "Navigation One"], [otherWorkspaceId, "Navigation Two"]]) {
        const renamed = await fetch(`http://127.0.0.1:${port}/workspaces/${id}/display-name`, {
          method: "PATCH", headers, body: JSON.stringify({ displayName }), signal: AbortSignal.timeout(15_000),
        });
        if (!renamed.ok) return renamed.status;
      }
      if (engine === "v2") {
        const model = await fetch(`${base}/model`, { method: "POST", headers,
          body: JSON.stringify({ model: { providerID, id: modelID } }), signal: AbortSignal.timeout(15_000) });
        if (!model.ok) return model.status;
      }
      const response = await fetch(`${base}/${engine === "v2" ? "prompt" : "message"}`, {
        method: "POST", headers,
        body: JSON.stringify(engine === "v2" ? { text, delivery: "steer" } : { model: { providerID, modelID }, parts: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok ? 200 : response.status;
    }, [one.workspaceId, two.workspaceId, a.sessionId, engine, "navigation-links-fixture", providerId, modelId]), { awaitPromise: true, timeoutMs: 40_000 });
    if (stored !== 200) throw new Error(`Navigation message arrangement failed: HTTP ${stored}`);
    return { app, one, two, a, b, c, d, route, async [Symbol.asyncDispose]() { await mock.stop(); } };
  } catch (error) { await mock.stop(); throw error; }
}
