import { browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A v2 `reasoning` object inside a v1 provider block, as reported in #6282. */
export const INVALID_FIELD = "provider.acme.models.report.reasoning";

export async function invalidOpencodeConfigWorld(seed: Seed) {
  const workspacePath = seed.tmpPath("invalid-opencode-config");
  // OpenCode v1 refuses every request in a folder whose config it cannot read.
  const app = await seed.appWeb({ name: "invalid-opencode-config", workspacePath, mouse: true, engine: "v1" });
  const workspace = await seed.workspace(app, workspacePath);
  const configPath = join(workspacePath, "opencode.json");
  return {
    app,
    workspace,
    configPath,
    /** Hand-edit the workspace's opencode.json into an invalid shape, then reload the engine and the page. */
    async breakConfig() {
      await writeFile(configPath, JSON.stringify({
        provider: { acme: { models: { report: { name: "Report", reasoning: { supported: true, effort: ["low", "high"] } } } } },
      }, null, 2));
      // TODO(primitive): seed.reloadEngine(app)
      const result = await seed.evalIn(app, browserScript(async (workspaceId) => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        if (!port || !token) return "missing local server credentials";
        const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` },
        });
        return response.ok ? "ok" : `engine reload failed: ${response.status}`;
      }, [workspace.workspaceId]), { awaitPromise: true, timeoutMs: 120_000 });
      if (result !== "ok") throw new Error(String(result));
      await reload(app);
    },
  };
}
