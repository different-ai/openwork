import { mkdir, realpath } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A signed-in member on OpenCode v2 with one conversation open. The
 * composer's Agents list is generally available without organization overrides.
 */
export async function composerSubagentTrackerWorld(seed: Seed) {
  const engine = "v2";
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Billing team", admin: { name: "Billing Owner" } } });
  const directory = seed.tmpPath("composer-subagent-tracker");
  await mkdir(directory, { recursive: true });
  const workspacePath = await realpath(directory);
  // The app only enables task creation once it has a usable model. A clean CI
  // runner has none, so the workspace gets a local model fixture; the spec
  // never sends a prompt, the sub-agent states come from the dev-only seed.
  const mock = seed.mock({ isolatedProcessEnv: true });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, workspacePath, name: "composer-subagent-tracker", engine, headless: true, mocks: { agent: mock },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing the model fixture for the Agents list world");
  const providerId = "subagent-tracker-mock";
  const modelId = "subagent-tracker-model";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Agents list mock",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-subagent-tracker-fixture" },
      models: { [modelId]: { name: "Agents list model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Billing release" });
  return { app, den, workspace, session };
}
