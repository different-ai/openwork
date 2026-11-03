import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const fileLinksPrompt = "Show the file references from the handoff, followed by the available workspace note.";
export const missingFileReferences = [
  { path: "/home/runner/eng-963-missing/report.md", label: "Runner report" },
  { path: "/workspace/eng-963-missing/summary.md", label: "Workspace summary" },
  { path: "/Users/other/eng-963-missing/notes.md", label: "Other computer notes" },
  { path: "notes/eng-963-missing.md", label: "Missing workspace note" },
];
export const availableNote = "This workspace note is available for preview.";

/** A real app and engine; only the model's handoff prose is deterministic. */
export async function chatFileLinks(seed: Seed) {
  const root = seed.tmpPath("chat-file-links");
  await mkdir(join(root, "notes"), { recursive: true });
  const workspacePath = await realpath(root);
  await writeFile(join(workspacePath, "notes", "available.md"), availableNote);
  const finalReply = [
    "Files from the handoff:",
    ...missingFileReferences.map(({ path, label }) => `\n${label}: \`${path}\` and [${label}](${path}).`),
    "\nAvailable workspace note: [Preview available note](notes/available.md).",
  ].join("\n");
  const mock = seed.mock({ agentWorkloads: [{
    promptMarker: fileLinksPrompt, latestUserTurn: true, finalReply, steps: [],
  }] });
  const app = await seed.appWeb({ name: "chat-file-links", workspacePath, mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The handoff model fixture did not start");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "file-links-model", "handoff", { provider: {
    "file-links-model": {
      npm: "@ai-sdk/openai-compatible", name: "Handoff model",
      options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-file-links-fixture" },
      models: { handoff: { name: "Handoff model" } },
    },
  } });
  await app.client.send("Browser.grantPermissions", {
    origin: new URL(app.webUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  return {
    app, workspace, workspacePath,
    replies: async () => (await agentMock.agentRequests({ promptMarker: fileLinksPrompt }))
      .filter((request) => request.kind === "final").length,
    // TODO(primitive): expose a read-only probe.clipboard witness without browser evaluation.
    readClipboard: () => seed.evalIn(app, () => navigator.clipboard.readText(), { awaitPromise: true }),
  };
}
