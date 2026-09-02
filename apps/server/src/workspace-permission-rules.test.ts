import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import {
  addWorkspacePermissionRule,
  listWorkspacePermissionRules,
  removeWorkspacePermissionRule,
  rulesFromPermissionBlock,
} from "./workspace-permission-rules.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const CLIENT_TOKEN = "owt_workspace_rules";
const HOST_TOKEN = "owt_workspace_rules_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const priorEnv = { dataDir: process.env.OPENWORK_DATA_DIR, tokenStore: process.env.OPENWORK_TOKEN_STORE };

async function workspaceRoot(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-rules-"));
  roots.push(root);
  if (content !== undefined) await writeFile(join(root, "opencode.json"), content, "utf8");
  return root;
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (priorEnv.dataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = priorEnv.dataDir;
  if (priorEnv.tokenStore === undefined) delete process.env.OPENWORK_TOKEN_STORE;
  else process.env.OPENWORK_TOKEN_STORE = priorEnv.tokenStore;
});

describe("workspace permission rules file edits", () => {
  test("flattens string shorthand and pattern maps the way the engine reads them", () => {
    expect(rulesFromPermissionBlock("allow")).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
    expect(rulesFromPermissionBlock({ bash: "ask", edit: { "*": "deny", "docs/*": "allow" } })).toEqual([
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "docs/*", action: "allow" },
    ]);
    expect(rulesFromPermissionBlock(undefined)).toEqual([]);
  });

  test("adds an allow entry while keeping the file's comments, and expands string shorthand instead of dropping it", async () => {
    const root = await workspaceRoot(`{
  // keep me
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "ask"
  }
}
`);
    expect(await addWorkspacePermissionRule(root, { permission: "bash", pattern: "git status *", action: "allow" })).toBe(true);
    const content = await readFile(join(root, "opencode.json"), "utf8");
    expect(content).toContain("// keep me");
    expect(await listWorkspacePermissionRules(root)).toEqual([
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "git status *", action: "allow" },
    ]);
    // Idempotent: the exact rule is not written twice.
    expect(await addWorkspacePermissionRule(root, { permission: "bash", pattern: "git status *", action: "allow" })).toBe(false);
    // A new permission key is created; a missing file is created too.
    expect(await addWorkspacePermissionRule(root, { permission: "webfetch_tool", pattern: "*", action: "allow" })).toBe(true);
    const fresh = await workspaceRoot();
    expect(await addWorkspacePermissionRule(fresh, { permission: "external_directory", pattern: "/shared/*", action: "allow" })).toBe(true);
    expect(await listWorkspacePermissionRules(fresh)).toEqual([{ permission: "external_directory", pattern: "/shared/*", action: "allow" }]);
  });

  test("keeps a top-level string shorthand as the catch-all when adding beside it", async () => {
    const root = await workspaceRoot(`{ "permission": "allow" }\n`);
    await addWorkspacePermissionRule(root, { permission: "edit", pattern: "secrets/*", action: "deny" });
    expect(await listWorkspacePermissionRules(root)).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "secrets/*", action: "deny" },
    ]);
  });

  test("removes an entry and drops an emptied permission object", async () => {
    const root = await workspaceRoot(JSON.stringify({ permission: { bash: { "git status *": "allow", "git push *": "deny" }, edit: "deny" } }));
    expect(await removeWorkspacePermissionRule(root, { permission: "bash", pattern: "git status *" })).toBe(true);
    expect(await removeWorkspacePermissionRule(root, { permission: "bash", pattern: "git status *" })).toBe(false);
    expect(await removeWorkspacePermissionRule(root, { permission: "bash", pattern: "git push *" })).toBe(true);
    expect(await removeWorkspacePermissionRule(root, { permission: "edit", pattern: "*" })).toBe(true);
    expect(await listWorkspacePermissionRules(root)).toEqual([]);
    const content = await readFile(join(root, "opencode.json"), "utf8");
    expect(JSON.parse(content)).toEqual({ permission: {} });
  });
});

describe("workspace permission rules routes", () => {
  test("lists, adds, and removes rules for collaborators and refuses viewers", async () => {
    const root = await workspaceRoot(JSON.stringify({ permission: { edit: "deny" } }));
    process.env.OPENWORK_DATA_DIR = join(root, "data");
    process.env.OPENWORK_TOKEN_STORE = join(root, "tokens.json");
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      configPath: join(root, "server.json"),
      token: CLIENT_TOKEN,
      hostToken: HOST_TOKEN,
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
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
    const base = `http://127.0.0.1:${server.port}/workspace/ws_1/permissions/rules`;
    const headers = { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };

    const listed = await fetch(base, { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ rules: [{ permission: "edit", pattern: "*", action: "deny" }], path: join(root, "opencode.json") });

    const added = await fetch(base, { method: "POST", headers, body: JSON.stringify({ permission: "bash", pattern: "git status *", action: "allow" }) });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      changed: true,
      rules: [{ permission: "edit", pattern: "*", action: "deny" }, { permission: "bash", pattern: "git status *", action: "allow" }],
    });
    expect(JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))).toEqual({ permission: { edit: "deny", bash: { "git status *": "allow" } } });

    const invalid = await fetch(base, { method: "POST", headers, body: JSON.stringify({ permission: "bash", pattern: "rm *", action: "maybe" }) });
    expect(invalid.status).toBe(400);

    const events = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/events`, { headers });
    const eventBody: unknown = await events.json();
    const items = typeof eventBody === "object" && eventBody !== null && "items" in eventBody && Array.isArray(eventBody.items) ? eventBody.items : [];
    expect(items.some((item) => typeof item === "object" && item !== null && "reason" in item && item.reason === "config")).toBe(true);

    const removed = await fetch(base, { method: "DELETE", headers, body: JSON.stringify({ permission: "bash", pattern: "git status *" }) });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ changed: true, rules: [{ permission: "edit", pattern: "*", action: "deny" }] });

    const issued = await fetch(`http://127.0.0.1:${server.port}/tokens`, {
      method: "POST",
      headers: { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ scope: "viewer", label: "viewer" }),
    });
    const viewer: unknown = await issued.json();
    const viewerToken = typeof viewer === "object" && viewer !== null && "token" in viewer && typeof viewer.token === "string" ? viewer.token : "";
    const viewerWrite = await fetch(base, {
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ permission: "bash", pattern: "*", action: "allow" }),
    });
    expect(viewerWrite.status).toBe(403);
    const viewerRead = await fetch(base, { headers: { authorization: `Bearer ${viewerToken}` } });
    expect(viewerRead.status).toBe(200);
  });
});
