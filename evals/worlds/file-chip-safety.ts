import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const fileChipPrompt = "Read my report.";
export async function fileChipSafety(seed: Seed) {
  const engine = resolveEvalEngine();
  const fixturePath = seed.tmpPath("file-chip-safety");
  await mkdir(fixturePath, { recursive: true });
  // macOS /tmp is a symlink. Give the engine the same real workspace path
  // that its file-permission check uses; do not bypass the permission rail.
  const workspacePath = await realpath(fixturePath);
  const path = join(workspacePath, "report.md");
  await writeFile(path, "# Report\n\nA preserved local report.\n");
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: fileChipPrompt, latestUserTurn: true, finalReply: "The report is ready for review.",
    steps: [{ tool: "read", arguments: { filePath: path, path } }],
  }] });
  const app = await seed.appWeb({ name: "file-chip-safety", workspacePath, headless: true, mocks: { agent: mock } });
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.agent;
  if (!witness) throw new Error("File model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "file-proof", "report", {
    permission: { "*": "allow" }, provider: { "file-proof": { npm: "@ai-sdk/openai-compatible", name: "Report model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-report-fixture" }, models: { report: { name: "Report model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Report review" });
  return { app, workspace, session, toolCalls: () => witness.toolCalls() };
}
