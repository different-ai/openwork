import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, parse } from "node:path";
import type { Seed } from "@openwork/env";
import { z } from "zod";

export async function workspaceWriteOutcome(seed: Seed) {
  const directory = seed.tmpPath("exp-wspath-report");
  await mkdir(directory, { recursive: true });
  // Match the engine's canonical directory on hosts where /var is a symlink.
  const workspace = await realpath(directory);
  const filename = "report.html";
  const content = "<!doctype html><title>Report</title><h1>Report</h1>";
  const failedPrompt = "Create a short report at the suggested location.";
  const successPrompt = "Create the report in this workspace instead.";
  const failedReply = "The report could not be saved.";
  const successReply = "The report is saved in the workspace.";
  const witness = seed.mock({ agentWorkloads: [
    { promptMarker: failedPrompt, latestUserTurn: true, finalReply: failedReply,
      steps: [{ tool: "write", arguments: { filePath: join(parse(workspace).root, "exp-wspath-proof-report.html"), content } }] },
    { promptMarker: successPrompt, latestUserTurn: true, finalReply: successReply,
      steps: [{ tool: "write", arguments: { filePath: filename, content } }] },
  ] });
  const token = randomUUID();
  const app = await seed.appWeb({ workspacePath: workspace, engine: "v1", name: "exp-wspath-write-outcome", headless: true,
    mocks: { agent: witness }, env: { OPENWORK_TOKEN: token } });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const listed = await fetch(`${app.openworkUrl}/workspaces`, { headers }).then(r => r.json());
  const workspaces = z.object({ workspaces: z.array(z.object({ id: z.string(), path: z.string() })) }).parse(listed).workspaces;
  const selected = workspaces.find(w => w.path === workspace);
  if (!selected) throw new Error("The test workspace is not registered");
  const mount = `/workspace/${selected.id}`;
  const configured = await fetch(`${app.openworkUrl}${mount}/config`, { method: "PATCH", headers, body: JSON.stringify({ opencode: {
    model: "workspace-proof/report", small_model: "workspace-proof/report",
    permission: { external_directory: "ask", edit: "allow", bash: "deny" },
    provider: { "workspace-proof": { npm: "@ai-sdk/openai-compatible", name: "Workspace proof", options: { baseURL: `${app.mocks.agent.url}/v1` },
      models: { report: { name: "Report model", limit: { context: 32768, output: 4096 } } } } },
  } }) });
  if (!configured.ok) throw new Error(`Provider configuration failed: ${configured.status}`);
  const reloaded = await fetch(`${app.openworkUrl}${mount}/engine/reload`, { method: "POST", headers });
  if (!reloaded.ok && reloaded.status !== 503 && reloaded.status !== 504) throw new Error(`Engine reload failed: ${reloaded.status}`);
  const sessionUrls: string[] = [];
  const sessionIds: string[] = [];
  for (const title of ["Report write failed", "Report saved"]) {
    const response = await fetch(`${app.openworkUrl}${mount}/opencode/session`, { method: "POST", headers, body: JSON.stringify({ title }) });
    if (!response.ok) throw new Error(`Arranging the report conversation failed: ${response.status}`);
    const session = z.object({ id: z.string() }).parse(await response.json());
    sessionIds.push(session.id);
    sessionUrls.push(`${app.webUrl}${mount}/session/${session.id}`);
  }
  return { app, sessionIds, sessionUrls, filename, destination: join(workspace, filename), content, failedPrompt, successPrompt, failedReply, successReply,
    async fileContent() { return readFile(join(workspace, filename), "utf8").catch(() => null); },
    async writes(sessionId: string) {
      const response = await fetch(`${app.openworkUrl}${mount}/opencode/session/${sessionId}/message`, { headers });
      if (!response.ok) throw new Error(`Reading the tool outcome failed: ${response.status}`);
      const messages: { parts: { type: string; tool?: string; state?: { status: string } }[] }[] = await response.json();
      return messages.flatMap(m => m.parts.filter(p => p.type === "tool" && p.tool === "write").map(p => p.state?.status));
    },
  };
}
