import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const spreadsheetPrompt = "Show my workbook and editable table.";
export async function spreadsheetReadOnly(seed: Seed) {
  const engine = resolveEvalEngine();
  const workspacePath = seed.tmpPath("spreadsheet-read-only");
  await mkdir(workspacePath, { recursive: true });
  const workbookPath = join(workspacePath, "preservation.xlsx");
  await copyFile(new URL("../../apps/app/tests/fixtures/preservation.xlsx", import.meta.url), workbookPath);
  await writeFile(join(workspacePath, "editable.csv"), "Name,Value\nOriginal,10\n");
  const hash = async () => createHash("sha256").update(await readFile(workbookPath)).digest("hex");
  const originalHash = await hash();
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: spreadsheetPrompt, latestUserTurn: true,
    finalReply: "Review [preservation.xlsx](preservation.xlsx), [editable.csv](editable.csv), or [missing.xlsx](missing.xlsx).", steps: [],
  }] });
  const app = await seed.appWeb({ name: "spreadsheet-read-only", workspacePath, headless: true, mocks: { agent: mock } });
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Spreadsheet model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "spreadsheet-proof", "table", {
    permission: { "*": "allow" }, provider: { "spreadsheet-proof": { npm: "@ai-sdk/openai-compatible", name: "Table model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-table-fixture" }, models: { table: { name: "Table model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Workbook review" });
  return { app, workspace, session, originalHash, workbookHash: hash,
    csv: () => readFile(join(workspacePath, "editable.csv"), "utf8"),
  };
}
