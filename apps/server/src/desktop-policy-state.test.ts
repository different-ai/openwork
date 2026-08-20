import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectDesktopPolicyState } from "./desktop-policy-state.js";
import { openworkDesktopPolicyLockPluginPath } from "./openwork-extensions-plugin-path.js";
import { OpenWorkDesktopPolicyLock } from "./opencode-plugins/openwork-desktop-policy-lock.js";
import { buildOpenworkRuntimeConfigObject } from "./openwork-runtime-config.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "owt_desktop_policy_client";
const HOST_TOKEN = "owt_desktop_policy_host";
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const previousServerUrl = process.env.OPENWORK_SERVER_URL;
const previousServerToken = process.env.OPENWORK_SERVER_TOKEN;
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  restoreEnv("OPENWORK_RUNTIME_DB", previousRuntimeDb);
  restoreEnv("OPENWORK_SERVER_URL", previousServerUrl);
  restoreEnv("OPENWORK_SERVER_TOKEN", previousServerToken);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Response body was not an object");
  return body;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function clientHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${CLIENT_TOKEN}`, "Content-Type": "application/json" };
}

function hostHeaders(): Record<string, string> {
  return { "X-OpenWork-Host-Token": HOST_TOKEN, "Content-Type": "application/json" };
}

function startMockOpencode() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.18.15" });
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/mcp") return Response.json({});
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

async function startOpenwork() {
  const root = await mkdtemp(join(tmpdir(), "openwork-desktop-policy-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const opencode = startMockOpencode();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${opencode.port}`,
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config, root };
}

async function putPolicy(base: string, state: {
  allowCreateSkills: boolean;
  allowAddMcpServers: boolean;
}): Promise<Response> {
  return fetch(`${base}/experimental/desktop-policy/state`, {
    method: "PUT",
    headers: hostHeaders(),
    body: JSON.stringify(state),
  });
}

describe("desktop policy state", () => {
  test("persists strict host updates and serves them to clients", async () => {
    const openwork = await startOpenwork();
    const putResponse = await putPolicy(openwork.base, {
      allowCreateSkills: false,
      allowAddMcpServers: true,
    });
    expect(putResponse.status).toBe(200);
    const putBody = await responseRecord(putResponse);
    expect(putBody).toMatchObject({
      ok: true,
      schemaVersion: 1,
      state: {
        allowCreateSkills: false,
        allowAddMcpServers: true,
        updatedAt: expect.any(Number),
      },
    });

    const persisted: unknown = JSON.parse(await readFile(join(openwork.root, "desktop-policy-state.json"), "utf8"));
    expect(persisted).toEqual(putBody.state);

    const getResponse = await fetch(`${openwork.base}/experimental/desktop-policy/state`, {
      headers: clientHeaders(),
    });
    expect(getResponse.status).toBe(200);
    expect(await responseRecord(getResponse)).toEqual(putBody);

    for (const invalid of [
      { allowCreateSkills: false, allowAddMcpServers: true, extra: true },
      { allowCreateSkills: "false", allowAddMcpServers: true },
      { allowCreateSkills: true },
      null,
    ]) {
      const response = await fetch(`${openwork.base}/experimental/desktop-policy/state`, {
        method: "PUT",
        headers: hostHeaders(),
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
      expect((await responseRecord(response)).code).toBe("invalid_payload");
    }
  });

  test("blocks restricted skill and MCP writes and flips both capability routes", async () => {
    const openwork = await startOpenwork();
    expect((await putPolicy(openwork.base, {
      allowCreateSkills: false,
      allowAddMcpServers: false,
    })).status).toBe(200);

    const skillResponse = await fetch(`${openwork.base}/workspace/ws_1/skills`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ name: "locked-skill", description: "Locked", content: "Instructions" }),
    });
    expect(skillResponse.status).toBe(403);
    expect(await responseRecord(skillResponse)).toMatchObject({
      code: "policy_restricted",
      details: { policy: "allowCreateSkills" },
    });

    const mcpResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        name: "locked-mcp",
        config: { type: "remote", url: "https://example.com/mcp", enabled: true },
      }),
    });
    expect(mcpResponse.status).toBe(403);
    expect(await responseRecord(mcpResponse)).toMatchObject({
      code: "policy_restricted",
      details: { policy: "allowAddMcpServers" },
    });

    for (const path of ["/capabilities", "/w/ws_1/capabilities"]) {
      const capabilities = await responseRecord(await fetch(`${openwork.base}${path}`, {
        headers: clientHeaders(),
      }));
      expect(requireRecord(capabilities.skills, "skills").write).toBe(false);
      expect(requireRecord(capabilities.mcp, "mcp").write).toBe(false);
    }
  });

  test("fails open when state is missing or invalid", async () => {
    const openwork = await startOpenwork();
    expect(await inspectDesktopPolicyState(openwork.config)).toEqual({
      status: "missing",
      state: { allowCreateSkills: true, allowAddMcpServers: true, updatedAt: 0 },
    });

    const capabilities = await responseRecord(await fetch(`${openwork.base}/capabilities`, {
      headers: clientHeaders(),
    }));
    expect(requireRecord(capabilities.skills, "skills").write).toBe(true);
    expect(requireRecord(capabilities.mcp, "mcp").write).toBe(true);

    const skillResponse = await fetch(`${openwork.base}/workspace/ws_1/skills`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ name: "default-skill", description: "Default", content: "Instructions" }),
    });
    expect(skillResponse.status).toBe(200);

    const mcpResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        name: "default-mcp",
        config: { type: "remote", url: "https://example.com/mcp", enabled: true },
      }),
    });
    expect(mcpResponse.status).toBe(200);

    await writeFile(join(openwork.root, "desktop-policy-state.json"), "{not json", "utf8");
    expect(await inspectDesktopPolicyState(openwork.config)).toEqual({
      status: "invalid",
      state: { allowCreateSkills: true, allowAddMcpServers: true, updatedAt: 0 },
    });
  });

  test("registers the engine lock and blocks restricted file tools and permissions", async () => {
    const openwork = await startOpenwork();
    expect((await putPolicy(openwork.base, {
      allowCreateSkills: false,
      allowAddMcpServers: false,
    })).status).toBe(200);
    process.env.OPENWORK_SERVER_URL = openwork.base;
    process.env.OPENWORK_SERVER_TOKEN = CLIENT_TOKEN;

    const hooks = await OpenWorkDesktopPolicyLock();
    await expect(hooks["tool.execute.before"](
      { tool: "write" },
      { args: { filePath: join(openwork.root, ".opencode", "skills", "demo", "SKILL.md") } },
    )).rejects.toThrow("disabled creating skills");
    await expect(hooks["tool.execute.before"](
      { tool: "multi_edit" },
      { args: { filePath: join(openwork.root, "opencode.jsonc") } },
    )).rejects.toThrow("file is managed");

    const permission: { status: "ask" | "deny" | "allow" } = { status: "ask" };
    await hooks["permission.ask"](
      { pattern: [join(openwork.root, ".opencode", "openwork.json")] },
      permission,
    );
    expect(permission.status).toBe("deny");

    const runtime = await buildOpenworkRuntimeConfigObject();
    if (!Array.isArray(runtime.plugin)) throw new Error("Runtime plugin list was missing");
    expect(runtime.plugin).toContain(openworkDesktopPolicyLockPluginPath());
    const packageJson: unknown = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
    const build = requireRecord(requireRecord(packageJson, "packageJson").scripts, "scripts").build;
    if (typeof build !== "string") throw new Error("Package build script was missing");
    expect(build).toContain("openwork-desktop-policy-lock.ts");
  });
});
