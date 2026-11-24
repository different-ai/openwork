import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export async function composerInlineSuggestions(seed: Seed) {
  const workspacePath = seed.tmpPath("slash-suggestions");
  const directory = join(workspacePath, ".opencode", "skills", "analytics-dashboard");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: analytics-dashboard\ndescription: Summarize key metrics.\n---\n\nPresent a dashboard of the supplied metrics.\n");
  await writeFile(join(workspacePath, "weekly-notes.txt"), "Weekly notes for the report.\n");
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Analytics workspace", admin: { name: "Workspace owner" } },
  });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, workspacePath, name: "inline-suggestions", headless: true,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The synthetic model did not start");
  await configureProvider(seed, app, workspace.workspaceId, "reports", "fixture", {
    enabled_providers: ["reports"],
    model: "reports/fixture",
    provider: { reports: {
      name: "Reports fixture", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-reports-key" },
      models: { fixture: { name: "Reports model", tool_call: true, limit: { context: 128000, output: 8192 } } },
    } },
  });
  const [task, draftTask] = await seed.sessions(app, ["Weekly report", "Compose a message"]);
  if (!task || !draftTask) throw new Error("Expected two tasks");
  return {
    app, task, draftTask,
    enableInlineSuggestions: () => enableOrganizationCapabilities(seed, den.admin, { composerInlineSuggestions: true }),
  };
}
