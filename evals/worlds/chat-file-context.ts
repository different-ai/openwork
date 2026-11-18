import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const fileContextPrompt = "Show the two benchmark handoffs and their report references, then the missing attachment.";
export const benchmarkDirectory = "results/Benchmark résumé/";
export const secondDirectory = "results/Second benchmark/";
export const benchmarkMarker = "CONTEXTUAL BENCHMARK: résumé report from the first handoff.";
export const secondMarker = "SECOND CONTEXTUAL BENCHMARK: report from the second handoff.";
export const decoyMarker = "DECOY ROOT REPORT: this is not either handoff report.";
export const missingPath = "results/missing-attachment.md";

/** Real renderer, workspace runtime, and engine; only the model prose is mocked.
 * Native paths outside home are covered by the implementation's main tests.
 * appWeb deliberately does not install a fake native desktop bridge.
 */
export async function chatFileContext(seed: Seed) {
  const root = seed.tmpPath("chat-file-context");
  await mkdir(join(root, benchmarkDirectory), { recursive: true });
  await mkdir(join(root, secondDirectory), { recursive: true });
  const workspacePath = await realpath(root);
  await writeFile(join(workspacePath, benchmarkDirectory, "benchmark-report.md"), benchmarkMarker);
  await writeFile(join(workspacePath, secondDirectory, "benchmark-report.md"), secondMarker);
  await writeFile(join(workspacePath, "benchmark-report.md"), decoyMarker);
  const finalReply = [
    "First benchmark handoff:",
    `Directory: \`${benchmarkDirectory}\``,
    "Report: `benchmark-report.md` and [Preview benchmark](benchmark-report.md).",
    "",
    "Second benchmark handoff:",
    `Directory: \`${secondDirectory}\``,
    "Report: `benchmark-report.md` and [Preview second benchmark](benchmark-report.md).",
    "",
    `Missing attachment: [Preview missing attachment](${missingPath}).`,
  ].join("\n\n");
  const mock = seed.mock({ agentWorkloads: [{
    promptMarker: fileContextPrompt, latestUserTurn: true, finalReply, steps: [],
  }] });
  const app = await seed.appWeb({ name: "chat-file-context", workspacePath, mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The contextual handoff model fixture did not start");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "file-context-model", "handoff", { provider: {
    "file-context-model": {
      npm: "@ai-sdk/openai-compatible", name: "Contextual handoff model",
      options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-file-context-fixture" },
      models: { handoff: { name: "Contextual handoff model" } },
    },
  } });
  return {
    app, workspace, workspacePath,
    replies: async () => (await agentMock.agentRequests({ promptMarker: fileContextPrompt }))
      .filter((request) => request.kind === "final").length,
  };
}
