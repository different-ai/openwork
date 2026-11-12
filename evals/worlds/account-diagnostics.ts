import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export async function accountDiagnostics(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const workspacePath = seed.tmpPath("account-diagnostics");
  await mkdir(workspacePath, { recursive: true });
  // A deliberately disabled connection makes the account menu offer diagnostics
  // without depending on an external MCP outage or writing renderer state.
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
    mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: false } },
  }));
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, workspacePath, name: "account-diagnostics", engine: "v2", headless: true,
  });
  return { app, workspace, advancedUrl: `${app.webUrl}/settings/advanced/developer` };
}
