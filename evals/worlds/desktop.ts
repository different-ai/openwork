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
  const den = await seed.den({
    provision: false,
    web: false,
    mocks: { ready: seed.mock({ allowUnauthenticatedMcp: true, isolatedProcessEnv: true }) },
  });
  const readyMock = den.mocks.ready;
  if (!readyMock) throw new Error("Missing Library readiness MCP witness");
  const handshakeSince = new Date().toISOString();
  const workspacePath = seed.tmpPath("library-mcp-config");
  const app = await seed.desktop({ name: "library-mcp-config" });
  const config = {
    ...handWrittenConfig,
    mcp: {
      ...handWrittenConfig.mcp,
      "ready-helper": { type: "remote", url: readyMock.mcpUrl, enabled: true, oauth: false },
    },
  };
  // The enabled server must be discovered from disk when the workspace opens.
  // Do not register it through the MCP API: that would bypass config loading.
  const configWrite = await seed.evalIn(app, browserScript(async (workspacePath: string, content: string) => {
    const result = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("writeOpencodeConfig", "project", workspacePath, content);
    return result ?? { ok: false, stderr: "desktop bridge unavailable" };
  }, [workspacePath, `${JSON.stringify(config, null, 2)}\n`]));
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const session = await seed.session(app);
  return { app, workspace, session, workspacePath, configWrite, readyMock, handshakeSince };
}
