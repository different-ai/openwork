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
  const world = await emptySession(seed);
  const mockRegistration = await seed.evalIn(world.app, browserScript(async (workspaceId: string, url: string) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) throw new Error("Library fixture requires the local OpenWork server");
    const response = await fetch(`${info.baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "ready-helper", config: { type: "remote", url, enabled: true, oauth: false } }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status };
  }, [world.workspace.workspaceId, readyMock.mcpUrl]), { timeoutMs: 35_000 });
  const config = {
    ...handWrittenConfig,
    mcp: {
      ...handWrittenConfig.mcp,
      "ready-helper": { type: "remote", url: readyMock.mcpUrl, enabled: true, oauth: false },
    },
  };
  const configWrite = await seed.evalIn(world.app, browserScript(async (workspacePath: string, content: string) => {
    const result = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("writeOpencodeConfig", "project", workspacePath, content);
    return result ?? { ok: false, stderr: "desktop bridge unavailable" };
  }, [world.workspacePath, `${JSON.stringify(config, null, 2)}\n`]));
  return { ...world, configWrite, mockRegistration, readyMock, handshakeSince };
}
