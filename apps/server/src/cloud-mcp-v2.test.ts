import { afterEach, expect, test } from "bun:test";
import { createNativeCloudMcpResolver, createRoutedCloudMcpRegistrar } from "./cloud-mcp-v2.js";
import type { EngineV2PreviewStatus } from "./engine-v2-preview.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()?.(); });
const workspace: WorkspaceInfo = { id: "fixture", name: "Fixture", path: "/tmp/connect fixture", preset: "starter", workspaceType: "local" };
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: "/tmp/connect-fixture.json", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
function status(chatRouting: boolean): EngineV2PreviewStatus {
  return { enabled: chatRouting, running: chatRouting, chatRouting, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [], migration: { state: "idle", imported: 0, skipped: 0, total: 0 } };
}

test("native diagnostics use scoped authenticated APIs and never fall back to v1 when v2 is down", async () => {
  const requests: Array<{ path: string; directory: string | null; auth: string | null }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, directory: url.searchParams.get("location[directory]"), auth: request.headers.get("Authorization") });
    return Response.json({ data: [] });
  } });
  stops.push(() => server.stop(true));
  let chatRouting = true;
  let running = true;
  const resolve = createNativeCloudMcpResolver({ status: () => status(chatRouting), connection: () => running ? { url: `http://127.0.0.1:${server.port}`, username: "fixture", password: "fixture-secret" } : undefined });
  await resolve(workspace)?.request("/api/model", workspace.path);
  expect(requests).toEqual([{ path: "/api/model", directory: workspace.path, auth: `Basic ${Buffer.from("fixture:fixture-secret").toString("base64")}` }]);
  expect(resolve({ ...workspace, workspaceType: "remote" })).toBeUndefined();
  running = false;
  await expect(resolve(workspace)?.request("/api/model", workspace.path)).rejects.toThrow("OpenCode v2 is not running");
  chatRouting = false;
  expect(resolve(workspace)).toBeUndefined();
});

test("v2 repair mirrors and reconnects the requested MCP; v1 and remote repairs retain their owner", async () => {
  const operations: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    operations.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(null, { status: 204 });
  } });
  stops.push(() => server.stop(true));
  let chatRouting = true;
  const register = createRoutedCloudMcpRegistrar({
    status: () => status(chatRouting), connection: () => ({ url: `http://127.0.0.1:${server.port}`, username: "fixture", password: "fixture" }),
    ensureWorkspaceReady: async () => { operations.push("ready"); },
    syncWorkspaceMcp: async () => { operations.push("sync"); },
  }, async () => { operations.push("v1-or-remote"); return { status: "ok", syncedNames: [], failures: [] }; });
  expect((await register(config, workspace, ["openwork-cloud"])).status).toBe("ok");
  expect(operations).toEqual(["ready", "sync", "POST /api/mcp/openwork-cloud/connect"]);
  await register(config, { ...workspace, workspaceType: "remote" });
  chatRouting = false;
  await register(config, workspace);
  expect(operations.slice(3)).toEqual(["v1-or-remote", "v1-or-remote"]);
});
