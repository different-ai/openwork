import { createServer, type Server } from "node:http";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { close, listen, readBody, sendJson } from "./openwork-server-cli.ts";

type ProviderFault = {
  marker: string;
  status: number;
  code: string;
  message: string;
  delayMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerWitness(faults: readonly ProviderFault[], requests: string[]): Server {
  return createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        sendJson(response, 200, { object: "list", data: [{ id: "failure-model", object: "model" }] });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        sendJson(response, 404, { error: { message: "not found" } });
        return;
      }
      const body = await readBody(request);
      requests.push(body);
      const fault = faults.find((candidate) => body.includes(candidate.marker));
      if (!fault) {
        sendJson(response, 200, {
          id: "chatcmpl-provider-error-title",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Provider error proof" }, finish_reason: "stop" }],
        });
        return;
      }
      if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      sendJson(response, fault.status, {
        error: { message: fault.message, type: "invalid_request_error", code: fault.code },
      });
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: { message: error instanceof Error ? error.message : "witness failed" } });
    });
  });
}

async function localProviderErrorWorld(seed: Seed, name: string, faults: readonly ProviderFault[]) {
  const requests: string[] = [];
  const provider = providerWitness(faults, requests);
  const baseUrl = await listen(provider);
  const providerId = `${name}-witness`;
  const modelId = "failure-model";
  try {
    const app = await seed.desktop({ name, model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath(name));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      model: `${providerId}/${modelId}`,
      small_model: `${providerId}/${modelId}`,
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Provider error witness",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "isolated-provider-error-witness" },
          models: { [modelId]: { name: "Provider error model", tool_call: false } },
        },
      },
    });
    const sessions = await seed.sessions(app, faults.map((_fault, index) => `Provider failure ${index + 1}`));
    return {
      app,
      workspace,
      sessions,
      faults,
      requestCount: (marker: string) => requests.filter((body) => body.includes(marker)).length,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}

export async function sessionModelNotFound(seed: Seed) {
  return localProviderErrorWorld(seed, "session-model-not-found", [{
    marker: "retired-model-proof",
    status: 404,
    code: "model_not_found",
    message: "model_not_found: The requested model does not exist.",
  }]);
}

export async function sessionBudgetExceeded(seed: Seed) {
  return localProviderErrorWorld(seed, "session-budget-exceeded", [
    { marker: "budget-400-proof", status: 400, code: "invalid_request_error", message: "Budget has been exceeded" },
    { marker: "budget-429-proof", status: 429, code: "budget_exceeded", message: "LiteLLM budget_exceeded" },
  ]);
}

export async function sessionDenDisconnected(seed: Seed) {
  const marker = "den-disconnected-proof";
  const requests: string[] = [];
  const provider = providerWitness([{ marker, status: 401, code: "unauthorized", message: "Provider authentication failed", delayMs: 10_000 }], requests);
  const baseUrl = await listen(provider);
  const den = await seed.den({ org: { name: "Disconnected model proof", admin: { name: "Proof Admin" } } });
  const modelId = "failure-model";
  try {
    const created = await seed.api(den.admin, "/v1/llm-providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Disconnected provider witness",
        source: "custom",
        customConfig: {
          id: "disconnected-provider-witness",
          name: "Disconnected provider witness",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${baseUrl}/v1` },
          env: ["DISCONNECTED_PROVIDER_WITNESS_API_KEY"],
          models: [{ id: modelId, name: "Disconnected provider model", tool_call: false }],
        },
        apiKey: "isolated-disconnected-witness",
        allMembers: true,
        memberIds: [],
        teamIds: [],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const llmProvider = isRecord(created.body) && isRecord(created.body.llmProvider)
      ? created.body.llmProvider
      : null;
    const providerId = llmProvider && typeof llmProvider.id === "string" ? llmProvider.id : "";
    if (created.response.status !== 201 || !/^lpr_/.test(providerId)) {
      throw new Error(`Disconnected provider setup failed: HTTP ${created.response.status}`);
    }
    const proxy = await seed.faultProxy(den);
    const app = await seed.desktop({ den: { ...den, ref: proxy.ref }, as: "admin", name: "session-den-disconnected", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("session-den-disconnected"));
    const selected = await seed.evalIn(app, browserScript(async (workspaceId, selectedProviderId, selectedModelId) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:${port}/cloud-provider-sync/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        if (response.ok && text.includes(selectedProviderId)) {
          let preferences: Record<string, unknown> = {};
          const raw = localStorage.getItem("openwork.preferences");
          try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
          localStorage.setItem("openwork.preferences", JSON.stringify({
            ...preferences,
            defaultModel: { providerID: selectedProviderId, modelID: selectedModelId },
            modelVariant: null,
            providerStepCompleted: true,
          }));
          localStorage.setItem("openwork.defaultModel", `${selectedProviderId}/${selectedModelId}`);
          localStorage.removeItem(`openwork.sessionModels.${workspaceId}`);
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    }, [workspace.workspaceId, providerId, modelId]), { awaitPromise: true, timeoutMs: 65_000 });
    if (!selected) throw new Error("Disconnected provider did not sync into the desktop runtime");
    await seed.evalIn(app, () => { location.reload(); return true; });
    const [session] = await seed.sessions(app, ["Den disconnected provider"]);
    if (!session) throw new Error("Disconnected provider session missing");
    return {
      app,
      workspace,
      session,
      marker,
      proxy,
      async disconnectDen() {
        await proxy.faults.status("/", 503, { times: 1000, body: { error: "den_unavailable" } });
      },
      requestCount: () => requests.filter((body) => body.includes(marker)).length,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}
