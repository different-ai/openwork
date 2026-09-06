import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const CLIENT_TOKEN = "owt_effective_permissions";
const HOST_TOKEN = "owt_effective_permissions_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorEnv = { dataDir: process.env.OPENWORK_DATA_DIR, tokenStore: process.env.OPENWORK_TOKEN_STORE };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Engine stand-in answering /config and /agent the way the pinned engine does. */
function fakeEngine(agents: unknown[]) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/config") return Response.json({ default_agent: "openwork" });
      if (url.pathname === "/agent") return Response.json(agents);
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (priorEnv.dataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = priorEnv.dataDir;
  if (priorEnv.tokenStore === undefined) delete process.env.OPENWORK_TOKEN_STORE;
  else process.env.OPENWORK_TOKEN_STORE = priorEnv.tokenStore;
});

describe("effective permissions route", () => {
  test("summarises the governing agent's ruleset and attributes each row to its layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-effective-permissions-"));
    roots.push(root);
    process.env.OPENWORK_DATA_DIR = join(root, "data");
    process.env.OPENWORK_TOKEN_STORE = join(root, "tokens.json");
    // The workspace file denies edits; the stand-in engine's ruleset reflects that merge.
    await writeFile(join(root, "opencode.json"), JSON.stringify({ permission: { edit: "deny" } }), "utf8");
    const engineUrl = fakeEngine([
      { name: "build", mode: "primary", hidden: false, permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      {
        name: "openwork",
        mode: "primary",
        hidden: false,
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "doom_loop", pattern: "*", action: "ask" },
          { permission: "external_directory", pattern: "*", action: "ask" },
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*.env", action: "ask" },
          { permission: "read", pattern: "*.env.*", action: "ask" },
          { permission: "read", pattern: "*.env.example", action: "allow" },
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "external_directory", pattern: "/shared/*", action: "allow" },
        ],
      },
    ]);
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      configPath: join(root, "server.json"),
      token: CLIENT_TOKEN,
      hostToken: HOST_TOKEN,
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", baseUrl: engineUrl }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    const server = await startServer(config) as Served;
    stops.push(() => server.stop(true));

    const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/permissions/effective`);
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/permissions/effective`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.rows)) throw new Error(`unexpected body ${JSON.stringify(body)}`);
    expect(body.agent).toBe("openwork");
    const rows = Object.fromEntries(body.rows.map((row) => [isRecord(row) ? String(row.key) : "", row]));
    expect(rows.shell).toMatchObject({ action: "allow", source: "engine", exceptions: 0 });
    expect(rows.edit).toMatchObject({ action: "deny", source: "workspace" });
    expect(rows.outside_folders).toMatchObject({ action: "ask", source: "engine", exceptions: 1 });
    expect(rows.env_files).toMatchObject({ action: "ask", source: "engine" });
    expect(rows.doom_loop).toMatchObject({ action: "ask", source: "engine" });
    expect(isRecord(body.files) ? body.files.workspace : null).toBe(join(root, "opencode.json"));

    const policyService = managedDesktopPolicy(config);
    const policyHeaders = { authorization: `Bearer ${policyService.evaluationToken}`, "Content-Type": "application/json" };
    const evaluate = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/managed-policy/evaluate`, {
      method: "POST", headers, body: JSON.stringify({ action: "shell", input: { command: "echo hello" } }),
    });
    expect((await evaluate({})).status).toBe(401);
    expect((await evaluate({ authorization: "Bearer invalid-policy-token" })).status).toBe(401);
    expect((await evaluate(policyHeaders)).status).toBe(200);
    expect((await evaluate({ authorization: `Bearer ${CLIENT_TOKEN}` })).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/workspaces"],
      ["GET", "/managed-policy"],
      ["GET", "/workspace/ws_1/permissions/effective"],
      ["PATCH", "/workspace/ws_1/config"],
      ["PUT", "/den-session"],
      ["POST", "/opencode/session"],
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: policyHeaders });
      expect({ method, path, status: rejected.status }).toEqual({ method, path, status: 401 });
    }
    const den = Bun.serve({ port: 0, fetch: () => Response.json({ allowControlSettings: false, execution: { commands: "deny" } }) });
    stops.push(() => den.stop(true));
    await policyService.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-den-token", orgId: "test-org" });
    const denied = await evaluate(policyHeaders);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "organization_policy_denied" });
    const deniedSettings = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/runtime-config/disabled-providers`, {
      method: "POST", headers: { authorization: `Bearer ${CLIENT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [] }),
    });
    expect(deniedSettings.status).toBe(403);
    expect(await deniedSettings.json()).toMatchObject({ code: "organization_policy_denied" });
  });
});
