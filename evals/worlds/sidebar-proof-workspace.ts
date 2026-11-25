import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** Local, signed-out workspace. The composer needs an available model to create chats; neither proof sends a prompt. */
export async function sidebarProofWorkspace(seed: Seed, name: string) {
  const workspacePath = seed.tmpPath(name);
  const app = await seed.appWeb({ name, workspacePath, engine: "v2", headless: true, mouse: true, mocks: { agent: seed.mock({ isolatedProcessEnv: true }) } });
  const workspace = await seed.workspace(app, workspacePath);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The local sidebar fixture did not start");
  const provider = "sidebar-demo";
  const model = "demo";
  await configureProvider(seed, app, workspace.workspaceId, provider, model, {
    enabled_providers: [provider], model: `${provider}/${model}`,
    provider: { [provider]: {
      npm: "@ai-sdk/openai-compatible", name: "Demo provider",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-unused" },
      models: { [model]: { name: "Demo model" } },
    } },
  }, "v2");
  return { app, workspace };
}
