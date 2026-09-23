import { mkdir, realpath } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/**
 * A person's OpenWork in the browser with two model providers they set up in
 * this workspace's opencode.json: a local runtime with two models and a
 * hosted one with a Claude and a Gemini model. No request reaches a model
 * provider; the world only lists models.
 */
export async function libraryModels(seed: Seed) {
  const temporaryPath = seed.tmpPath("library-models");
  await mkdir(temporaryPath, { recursive: true });
  const workspacePath = await realpath(temporaryPath);
  const app = await seed.appWeb({ name: "library-models", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "studio-llama", "llama-small", { provider: {
    "studio-llama": {
      npm: "@ai-sdk/openai-compatible", name: "Studio Llama",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-local-key" },
      models: { "llama-small": { name: "Llama 3.2 Small" }, "llama-large": { name: "Llama 3.3 Large" } },
    },
    "studio-router": {
      npm: "@ai-sdk/openai-compatible", name: "Studio Router",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-router-key" },
      models: { "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" }, "gemini-2.5-flash": { name: "Gemini 2.5 Flash" } },
    },
  } });
  return { app, workspace };
}
