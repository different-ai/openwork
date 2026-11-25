import { browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Real sign-in, engine model catalog and Connect health. Only inference is
 * synthetic. The stale saved preference is arranged before the first user act;
 * no health response, renderer store or diagnostic result is mocked. */
export async function connectEffectiveModel(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const providerID = "connect-proof";
  const modelID = "workspace-model";
  const modelName = "Workspace model";
  const stale = { providerID: "retired-provider", modelID: "retired-model" };
  const mock = seed.mock({ isolatedProcessEnv: true });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine: "v2", headless: true, name: "connect-effective-model",
    workspacePath: seed.tmpPath("connect-effective-model"), mocks: { agent: mock },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The synthetic inference endpoint did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerID, modelID, {
    provider: { [providerID]: {
      npm: "@ai-sdk/openai-compatible", name: "Workspace provider",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-connect-proof-key" },
      models: { [modelID]: { name: modelName, tool_call: true } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Workspace planning" });
  // This fixture deliberately recreates persisted state from an older profile.
  // Evaluation is confined to world arrangement, never used for user actions.
  const retiredPreferenceSaved = await seed.evalIn(app, browserScript((sessionId, providerID, modelID, stale) => {
    const raw = localStorage.getItem("openwork.preferences");
    const preferences = raw ? JSON.parse(raw) : {};
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...preferences, defaultModel: stale }));
    localStorage.setItem("openwork.defaultModel", `${stale.providerID}/${stale.modelID}`);
    localStorage.setItem("openwork.sessionModels.v1", JSON.stringify({
      [sessionId]: { model: { providerID, modelID }, variant: null },
    }));
    return localStorage.getItem("openwork.defaultModel") === `${stale.providerID}/${stale.modelID}`;
  }, [session.sessionId, providerID, modelID, stale]));
  const requests: Array<{ path: string; provider: string | null; model: string | null; status?: number }> = [];
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Connect health observation requires browser CDP");
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connect observer connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Connect observer connection failed")); }, { once: true });
  });
  const byId = new Map<string, (typeof requests)[number]>();
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!message || typeof message !== "object") return;
    const params = Reflect.get(message, "params");
    if (!params || typeof params !== "object") return;
    const requestId = Reflect.get(params, "requestId");
    if (typeof requestId !== "string") return;
    if (Reflect.get(message, "method") === "Network.requestWillBeSent") {
      const request = Reflect.get(params, "request");
      if (!request || typeof request !== "object") return;
      const rawUrl = Reflect.get(request, "url");
      if (typeof rawUrl !== "string") return;
      const url = new URL(rawUrl);
      if (!url.pathname.endsWith("/mcp/openwork-cloud/health")) return;
      // Only the path, model context and HTTP status are retained. No headers,
      // bearer credentials, cookies or response contents enter evidence.
      const entry = { path: url.pathname, provider: url.searchParams.get("provider"), model: url.searchParams.get("model") };
      requests.push(entry);
      byId.set(requestId, entry);
    }
    if (Reflect.get(message, "method") === "Network.responseReceived") {
      const response = Reflect.get(params, "response");
      const entry = byId.get(requestId);
      if (!entry || !response || typeof response !== "object") return;
      const status = Reflect.get(response, "status");
      if (typeof status === "number") entry.status = status;
    }
  });
  socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  await reload(app);
  return {
    app, workspace, session, providerID, modelID, modelName, stale, retiredPreferenceSaved,
    healthRequests: () => [...requests],
    async [Symbol.asyncDispose]() { socket.close(); },
  };
}
