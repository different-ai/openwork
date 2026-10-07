import { mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SkipError, type Seed } from "@openwork/env";
import {
  buildLocalProviderInstallPatch,
  buildLocalProviderSyncPatch,
  fetchOllamaModelCapabilities,
  fetchOllamaSyncInput,
  OLLAMA_PROVIDER_CONFIG,
} from "../../apps/app/src/react-app/domains/settings/openai-image-extension.ts";
import { bootManagedOpenworkServer, close, engineBinary, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

/** What the fake Ollama reports from `/api/show` for each pulled model. */
export const OLLAMA_MODELS: Record<string, { capabilities: string[]; thinking?: { values: unknown[]; default?: unknown } }> = {
  "gpt-oss:120b": { capabilities: ["completion", "tools", "thinking"], thinking: { values: ["low", "medium", "high"], default: "medium" } },
  "deepseek-v4-pro": { capabilities: ["completion", "tools", "thinking"], thinking: { values: ["none", "low", "high", "max"], default: "high" } },
  "gemma4": { capabilities: ["completion", "vision", "thinking"], thinking: { values: [false, true], default: true } },
  "qwen2.5-coder:7b": { capabilities: ["completion", "tools"], thinking: { values: [false] } },
  "glm-5.3": { capabilities: ["completion", "tools", "thinking"], thinking: { values: ["low", "high", "max"], default: "high" } },
};
export const REPLY = "Local model reply.";

export type ChatRequest = { model: string; effort: unknown; title: boolean };

/**
 * A fake Ollama (`/api/show` and the OpenAI-compatible chat endpoint) behind a
 * real openwork-server and the pinned engine. Models are added exactly as
 * Settings > Ollama adds them: the app's capability read, the app's config
 * patch, then an engine reload.
 */
export async function ollamaLocalModels(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");
  const root = seed.tmpPath("ollama-local-models");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });

  const shown: string[] = [];
  /** Models pulled in the fake Ollama, as `/api/tags` lists them. */
  const installed = new Set(Object.keys(OLLAMA_MODELS));
  const chats: ChatRequest[] = [];
  const ollama = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/api/tags") {
        return sendJson(response, 200, { models: [...installed].map((name) => ({ name, model: name, size: 1 })) });
      }
      if (request.method !== "POST") return sendJson(response, 200, { object: "list", data: [] });
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (!isRecord(body)) return sendJson(response, 400, {});
      if (request.url === "/api/show") {
        const model = typeof body.model === "string" && installed.has(body.model) ? OLLAMA_MODELS[body.model] : undefined;
        if (!model || typeof body.model !== "string") return sendJson(response, 404, { error: "model not found" });
        shown.push(body.model);
        return sendJson(response, 200, { details: { family: "test" }, ...model });
      }
      if (request.url !== "/v1/chat/completions" || typeof body.model !== "string") return sendJson(response, 404, {});
      chats.push({ model: body.model, effort: body.reasoning_effort ?? null, title: raw.includes("Generate a title for this conversation") });
      const id = `chatcmpl_${chats.length}`;
      sendStream(response, [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] },
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    })().catch(() => { if (!response.headersSent) sendJson(response, 500, {}); else response.end(); });
  });
  const ollamaURL = await listen(ollama);
  const token = "ollama-local-models-client";
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  const dispose = async () => {
    await managed?.stop();
    await close(ollama);
    await rm(scratch, { recursive: true, force: true });
  };

  try {
    const server = await bootManagedOpenworkServer({ scratch, workspace, token, binary, sink: () => undefined });
    managed = server;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const workspaceUrl = `${server.base}/workspace/${encodeURIComponent(server.workspaceId)}`;

    const reload = async () => {
      const reloaded = await fetch(`${workspaceUrl}/engine/reload`, { method: "POST", headers, signal: AbortSignal.timeout(90_000) });
      if (!reloaded.ok) throw new Error(`Engine reload failed: ${reloaded.status} ${await reloaded.text()}`);
    };

    /** Settings > Ollama > Add to workspace, for one pulled model. */
    const addModel = async (modelId: string) => {
      const baseURL = `${ollamaURL}/v1`;
      const capabilities = await fetchOllamaModelCapabilities(modelId, baseURL);
      const patch = buildLocalProviderInstallPatch({
        providerId: OLLAMA_PROVIDER_CONFIG.providerId, name: OLLAMA_PROVIDER_CONFIG.name, baseURL,
        modelId, modelName: modelId, setDefault: false, ...capabilities,
      });
      const patched = await fetch(`${workspaceUrl}/config`, { method: "PATCH", headers, body: JSON.stringify(patch) });
      if (!patched.ok) throw new Error(`Adding ${modelId} failed: ${patched.status} ${await patched.text()}`);
      await reload();
      return capabilities;
    };

    /** Settings > Ollama > Sync all models. */
    const syncModels = async () => {
      const input = await fetchOllamaSyncInput(`${ollamaURL}/v1`);
      if (!input) throw new Error("Ollama was not reachable for sync");
      const patched = await fetch(`${workspaceUrl}/config`, { method: "PATCH", headers, body: JSON.stringify(buildLocalProviderSyncPatch(input)) });
      if (!patched.ok) throw new Error(`Sync failed: ${patched.status} ${await patched.text()}`);
      await reload();
      return input.models.map((model) => model.modelId);
    };

    /** The person removes a model with `ollama rm`, outside OpenWork. */
    const removeFromOllama = (modelId: string) => { installed.delete(modelId); };

    /** Each Ollama model the engine offers, with its thinking levels (sorted; the picker orders them itself). */
    const pickerModels = async (): Promise<Record<string, string[]>> => {
      const payload = await server.engine("GET", "/provider");
      const providers = isRecord(payload) && Array.isArray(payload.all) ? payload.all : [];
      const provider = providers.find((entry) => isRecord(entry) && entry.id === OLLAMA_PROVIDER_CONFIG.providerId);
      const models = isRecord(provider) && isRecord(provider.models) ? provider.models : {};
      return Object.fromEntries(Object.entries(models).map(([id, model]) => [id,
        isRecord(model) && isRecord(model.variants) ? Object.keys(model.variants).sort() : []]));
    };

    /** Sends one prompt with a thinking level (null = Default) and returns what reached Ollama. */
    const send = async (modelID: string, variant: string | null): Promise<ChatRequest> => {
      const session = await server.engine("POST", "/session", {});
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("Session was not created");
      const offset = chats.length;
      const result = await server.engine("POST", `/session/${session.id}/message`, {
        model: { providerID: OLLAMA_PROVIDER_CONFIG.providerId, modelID }, ...(variant === null ? {} : { variant }),
        parts: [{ type: "text", text: "Say hello." }],
      });
      const replied = isRecord(result) && Array.isArray(result.parts) && result.parts.some((part) => isRecord(part) && part.text === REPLY);
      if (!replied) throw new Error(`No reply from ${modelID}: ${JSON.stringify(result).slice(0, 400)}`);
      const request = chats.slice(offset).find((entry) => entry.model === modelID && !entry.title);
      if (!request) throw new Error(`No chat request for ${modelID} reached Ollama`);
      return request;
    };

    return { shown, addModel, syncModels, removeFromOllama, pickerModels, send, [Symbol.asyncDispose]: dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
