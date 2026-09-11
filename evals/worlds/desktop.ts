import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

// Cover both Claude-style string commands and OpenCode's command arrays.
const handWrittenConfig = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    "docs-helper": { type: "local", command: "python3", args: ["-m", "http.server", "8321"], enabled: false },
    "files-helper": { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"], enabled: false },
    "remote-helper": { type: "remote", url: "https://mcp.example.test/sse", enabled: false },
  },
};

export async function emptySession(seed: Seed) {
  const workspacePath = seed.tmpPath("empty-session");
  const app = await seed.desktop({ name: "empty-session" });
  // Create the workspace at the declared tmp path. Without `create`, the seed
  // adopts the first-launch default workspace, which the dev profile places
  // inside the repo checkout on Daytona; the engine then merges the repo's
  // `.opencode/opencode.json` (`"permission": "allow"`) over the workspace's
  // own permission block, so workspace-level permission claims never hold.
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const session = await seed.session(app);
  return { app, workspace, session, workspacePath };
}

export async function libraryMcpServersFromConfig(seed: Seed) {
  const world = await emptySession(seed);
  const configWrite = await seed.evalIn(world.app, browserScript(async (workspacePath: string, content: string) => {
    const result = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("writeOpencodeConfig", "project", workspacePath, content);
    return result ?? { ok: false, stderr: "desktop bridge unavailable" };
  }, [world.workspacePath, `${JSON.stringify(handWrittenConfig, null, 2)}\n`]));
  return { ...world, configWrite };
}
