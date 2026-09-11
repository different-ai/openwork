import { addInitScript, browserScript, type Surface } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/**
 * Cloud-managed (Den) provider definitions on the native v2 engine.
 *
 * Den materializes an organization provider into the engine-global runtime
 * config as a catalog-shaped record: catalog identity `id` (for example
 * `openai`), the catalog `npm` package, `api`, `options`, and its model
 * records. This world writes the same shape through the workspace config
 * route, which lands in the same engine-global row the Den sync uses.
 *
 * Runtime provider keys deliberately avoid the `lpr_` prefix: the signed-out
 * app sweeps `lpr_*` keys as orphans, and the mirror keys its behavior on the
 * catalog identity, not the key. Credentials use the explicit `options.apiKey`
 * resolution path because the host-token env store is not reachable from the
 * headless web lane.
 */
async function seedSessionRetry(seed: Seed, app: Surface, title: string): Promise<{ sessionId: string; title: string }> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function managedVariantsWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  // Catalog-backed: no Den `variants`, so the engine derives effort choices.
  const providerId = "managed-openai-witness";
  const modelId = "gpt-5.4";
  const standardModelId = "gpt-4.1";
  const apiKey = "managed-den-resolved-key";
  // Den-pinned: explicit `variants` win over the catalog for this provider.
  const pinnedProviderId = "managed-openai-pinned";
  const pinnedModelId = "gpt-5.1";
  const pinnedApiKey = "managed-den-pinned-key";
  const prompt = "Explain why the sky looks blue.";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: prompt, latestUserTurn: true, finalReply: "Air scatters blue light more strongly.", steps: [],
  }] });
  const workspacePath = seed.tmpPath("model-managed-variants");
  const app = await seed.appWeb({ name: "model-managed-variants", workspacePath, mocks: { agent: mock } });
  // Observe model references without consuming or changing the app's requests.
  await addInitScript(app.client, () => {
    window.__modelEffortRequests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "POST" && /\/opencode2\/api\/session\/[^/]+\/model$/.test(new URL(url, location.href).pathname)) {
        const body: unknown = await new Request(input instanceof Request ? input.clone() : input, init).json();
        window.__modelEffortRequests?.push(body);
      }
      return originalFetch(input, init);
    };
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing managed provider witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: {
    [providerId]: {
      id: "openai", npm: "@ai-sdk/openai", name: "Managed OpenAI witness", api: "https://api.openai.com/v1",
      options: { baseURL: `${witness.url}/v1`, apiKey },
      models: {
        [modelId]: { id: modelId, name: "GPT-5.4 witness", reasoning: true, release_date: "2026-03-05" },
        [standardModelId]: { id: standardModelId, name: "GPT-4.1 witness", reasoning: false, release_date: "2025-04-14" },
      },
    },
    [pinnedProviderId]: {
      id: "openai", npm: "@ai-sdk/openai", name: "Managed OpenAI pinned", api: "https://api.openai.com/v1",
      options: { baseURL: `${witness.url}/v1`, apiKey: pinnedApiKey },
      models: {
        [pinnedModelId]: { id: pinnedModelId, name: "GPT-5.1 pinned", reasoning: true, release_date: "2025-11-13", variants: {
          low: { reasoningEffort: "low" }, CustomExact: { reasoningEffort: "high" },
          hidden: { disabled: true, reasoningEffort: "high" },
        } },
      },
    },
  } }, engine);
  const session = await seedSessionRetry(seed, app, "Managed effort contract");
  return { app, engine, workspace, session, prompt, providerId, modelId, standardModelId, apiKey, pinnedProviderId, pinnedModelId, pinnedApiKey,
    modelRequests: () => seed.evalIn(app, () => window.__modelEffortRequests ?? []),
    runtimeFacts: async () => ({
      ...await seed.evalIn(app, () => ({ browser: navigator.userAgent, electronBridge: Boolean(window.__OPENWORK_ELECTRON__) })),
      sourceSha: app.actualSourceSha,
    }),
    readNative: (path: string) => seed.evalIn(app, browserScript(async (path) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    }, [path]), { awaitPromise: true, timeoutMs: 20_000 }),
    requests: async () => (await witness.agentRequests({ promptMarker: prompt })).filter((request) => request.kind === "final"),
  };
}
