import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const producedFilePrompt = "Prepare a two-sheet budget workbook.";
export async function producedFileEvidence(seed: Seed) {
  // This tool ships on v1. A second world below proves the native v2 path.
  const engine = "v1";
  const workspacePath = seed.tmpPath("produced-file-evidence");
  await mkdir(workspacePath, { recursive: true });
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: producedFilePrompt, latestUserTurn: true,
    // Deliberately no English trigger words or filename in the reply.
    finalReply: "Voilà. La feuille est prête.",
    steps: [
      { tool: "spreadsheet_write", arguments: { path: "budget.xlsx", sheets: [
        { name: "Summary", rows: [["Total", 30]] }, { name: "Inputs", rows: [["North", 10], ["South", 20]] },
      ] } },
      // Merely printing a plausible path must not promote another artifact.
      { tool: "bash", arguments: { command: "printf 'not-produced.pdf\\n'", description: "Read a reference" } },
    ],
  }] });
  const app = await seed.appWeb({ name: "produced-file-evidence", workspacePath, engine, headless: true, mocks: { agent: mock } });
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Export model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "export-proof", "workbook", {
    permission: { "*": "allow" }, provider: { "export-proof": { npm: "@ai-sdk/openai-compatible", name: "Workbook model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-export-fixture" }, models: { workbook: { name: "Workbook model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Budget export" });
  return { app, workspace, session,
    workbookSignature: async () => (await readFile(join(workspacePath, "budget.xlsx"))).subarray(0, 2).toString(),
  };
}

export const producedFileV2Prompt = "Prepare my summary.";
async function nativeFileEvidence(seed: Seed, pathFree: boolean) {
  const engine = "v2";
  const name = pathFree ? "produced-file-evidence-path-free" : "produced-file-evidence-v2";
  const token = "produced-file-fixture-client";
  const hostToken = "produced-file-fixture-host";
  const workspacePath = seed.tmpPath(name);
  await mkdir(workspacePath, { recursive: true });
  if (pathFree) await writeFile(join(workspacePath, "a-unrelated.md"), "# Unrelated reference\n");
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: producedFileV2Prompt, latestUserTurn: true,
    finalReply: pathFree ? "Voilà." : "Voilà. summary.md",
    steps: [
      { tool: "shell", arguments: { command: "printf '# Summary\\n\\nThe requested summary.\\n' > summary.md", description: "Prepare the summary" } },
      { tool: "shell", arguments: { command: "printf 'not-produced.pdf\\n'", description: "Read a reference" } },
    ],
  }] });
  const app = await seed.appWeb({ name, workspacePath, engine, headless: true, mocks: { agent: mock }, env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken } });
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Native summary model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "summary-proof", "summary", {
    permission: { "*": "allow" }, provider: { "summary-proof": { npm: "@ai-sdk/openai-compatible", name: "Summary model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-summary-fixture" }, models: { summary: { name: "Summary model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Summary export" });
  return { app, workspace, session, summary: () => readFile(join(workspacePath, "summary.md"), "utf8"),
    async nativeEvidence() {
      const response = await fetch(`${app.openworkUrl}/workspace/${workspace.workspaceId}/opencode2/api/session/${session.sessionId}/message`, {
        headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Reading native change evidence failed: ${response.status}`);
      const payload: unknown = await response.json();
      const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
      const messages = record(payload) && Array.isArray(payload.data) ? payload.data.filter(record) : [];
      if (!messages.length) throw new Error("The native history witness returned no messages");
      const content = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(record) : []);
      const tools = content.filter(part => part.type === "tool").map(part => {
        const state = record(part.state) ? part.state : {};
        return { tool: part.tool ?? part.name, stateKeys: Object.keys(state), metadataKeys: record(state.metadata) ? Object.keys(state.metadata) : [] };
      });
      return { messageKeys: [...new Set(messages.flatMap(Object.keys))], contentTypes: [...new Set(content.map(part => part.type))], tools };
    },
  };
}

export async function producedFileV2Evidence(seed: Seed) { return nativeFileEvidence(seed, false); }
/** Diagnostic boundary, not a claim that path-free shell output discovery is fixed. */
export async function producedFileV2PathFreeEvidence(seed: Seed) { return nativeFileEvidence(seed, true); }
