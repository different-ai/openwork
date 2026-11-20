import { go } from "@openwork/behaviors";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function productAnalytics(seed: Seed) {
  const workspacePath = seed.tmpPath("product-analytics");
  const app = await seed.appWeb({
    name: "product-analytics", workspacePath, engine: "v2",
    env: { OPENWORK_HOST_TOKEN: "analytics-fixture-host-token", VITE_OPENWORK_HOST_TOKEN: "analytics-fixture-host-token" },
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: "Say hello", latestUserTurn: true, finalReply: "Hello from the fixture.", steps: [],
    }] }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The deterministic model did not start");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "analytics-fixture", "first", {
    provider: { "analytics-fixture": {
      npm: "@ai-sdk/openai-compatible", name: "Analytics fixture",
      options: { baseURL: `${mock.url}/v1`, apiKey: "fixture-only" },
      models: { first: { name: "First fixture model" }, second: { name: "Second fixture model" } },
    } },
  }, "v2");
  await go(app, "/session");
  const additionalWorkspacePath = join(workspacePath, "additional-workspace");
  await mkdir(additionalWorkspacePath, { recursive: true });
  return {
    app, additionalWorkspacePath,
    // The inspector is the local analytics sink; this observes captures without sending telemetry.
    events: () => seed.evalIn(app, () => (window.__openwork?.events(200) ?? [])
      .filter(event => event.name.startsWith("analytics."))),
  };
}
