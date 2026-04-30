import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAuditEntries } from "./audit.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorDataDir = process.env.OPENWORK_DATA_DIR;
const priorHome = process.env.HOME;

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  if (priorDataDir === undefined) {
    delete process.env.OPENWORK_DATA_DIR;
  } else {
    process.env.OPENWORK_DATA_DIR = priorDataDir;
  }
  if (priorHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = priorHome;
  }
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-mcp-routes-"));
  roots.push(root);
  await mkdir(join(root, ".opencode"), { recursive: true });
  await writeFile(
    join(root, "opencode.jsonc"),
    `${JSON.stringify(
      {
        mcp: {
          stripe: {
            type: "remote",
            url: "https://example.com/mcp",
            enabled: true,
            oauth: {
              clientId: "client-1",
              refreshToken: "refresh-1",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

async function createGlobalConfigRoot() {
  const homeRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-routes-home-"));
  roots.push(homeRoot);
  process.env.HOME = homeRoot;
  await mkdir(join(homeRoot, ".config", "opencode"), { recursive: true });
  await writeFile(
    join(homeRoot, ".config", "opencode", "opencode.jsonc"),
    `${JSON.stringify(
      {
        mcp: {
          inherited: {
            type: "remote",
            url: "https://example.com/global-mcp",
            enabled: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return homeRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function startOpenworkServer(input: { workspaceRoot: string; readOnly?: boolean; approvalMode?: "auto" | "manual" }) {
  const dataDir = join(input.workspaceRoot, ".openwork-test-data");
  process.env.OPENWORK_DATA_DIR = dataDir;
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_mcp_route_client_token",
    hostToken: "owt_mcp_route_host_token",
    approval: { mode: input.approvalMode ?? "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Test Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: input.readOnly ?? false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
  const server = startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, hostToken: config.hostToken };
}

async function waitForApproval(base: string, hostToken: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/approvals`, {
      headers: { "x-openwork-host-token": hostToken },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    if (body.items[0]) return body.items[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("approval_not_created");
}

describe("mcp routes", () => {
  test("PATCH toggles an MCP app and records audit plus reload event", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot });

    const pause = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);
    const pauseBody = (await pause.json()) as {
      changed: boolean;
      enabled: boolean;
      items: Array<{ name: string; config: Record<string, unknown> }>;
    };
    expect(pauseBody.changed).toBe(true);
    expect(pauseBody.enabled).toBe(false);
    expect(pauseBody.items.find((entry) => entry.name === "stripe")?.config.enabled).toBe(false);

    const configText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
    expect(configText).toContain("\"enabled\": false");
    expect(configText).toContain("\"https://example.com/mcp\"");
    expect(configText).toContain("\"refreshToken\": \"refresh-1\"");

    const audits = await readAuditEntries(workspaceRoot, "ws_1");
    expect(audits[0]).toMatchObject({
      action: "mcp.update",
      summary: "Paused MCP stripe",
    });

    const events = await fetch(`${base}/workspace/ws_1/events?since=0`, { headers: auth(token) });
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as {
      items: Array<{ reason: string; trigger?: { type?: string; name?: string; action?: string } }>;
    };
    expect(eventsBody.items).toContainEqual(
      expect.objectContaining({
        reason: "mcp",
        trigger: { type: "mcp", name: "stripe", action: "updated" },
      }),
    );

    const resume = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(resume.status).toBe(200);
    const resumeBody = (await resume.json()) as { items: Array<{ name: string; config: Record<string, unknown> }> };
    expect(resumeBody.items.find((entry) => entry.name === "stripe")?.config.enabled).toBe(true);
  });

  test("PATCH no-ops without audit or reload when enabled state is unchanged", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot });

    const response = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean; enabled: boolean };
    expect(body).toMatchObject({ changed: false, enabled: true });

    const audits = await readAuditEntries(workspaceRoot, "ws_1");
    expect(audits).toHaveLength(0);

    const events = await fetch(`${base}/workspace/ws_1/events?since=0`, { headers: auth(token) });
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as { items: Array<{ reason: string }> };
    expect(eventsBody.items.some((event) => event.reason === "mcp")).toBe(false);
  });

  test("legacy POST enable route shares PATCH toggle semantics", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot });

    const pause = await fetch(`${base}/workspace/ws_1/mcp/stripe/enabled`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);
    const pauseBody = (await pause.json()) as {
      changed: boolean;
      enabled: boolean;
      items: Array<{ name: string; config: Record<string, unknown> }>;
    };
    expect(pauseBody.changed).toBe(true);
    expect(pauseBody.enabled).toBe(false);
    expect(pauseBody.items.find((entry) => entry.name === "stripe")?.config.enabled).toBe(false);

    const audits = await readAuditEntries(workspaceRoot, "ws_1");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "mcp.disable",
      summary: "Disabled MCP stripe",
    });

    const noOp = await fetch(`${base}/workspace/ws_1/mcp/stripe/enabled`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(noOp.status).toBe(200);
    const noOpBody = (await noOp.json()) as { changed: boolean; enabled: boolean };
    expect(noOpBody).toMatchObject({ changed: false, enabled: false });

    const auditsAfterNoOp = await readAuditEntries(workspaceRoot, "ws_1");
    expect(auditsAfterNoOp).toHaveLength(1);

    const events = await fetch(`${base}/workspace/ws_1/events?since=0`, { headers: auth(token) });
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as { items: Array<{ reason: string }> };
    expect(eventsBody.items.filter((event) => event.reason === "mcp")).toHaveLength(1);
  });

  test("PATCH returns current state if the MCP app is removed during approval", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token, hostToken } = startOpenworkServer({ workspaceRoot, approvalMode: "manual" });

    const pendingPatch = fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });

    const approval = await waitForApproval(base, hostToken);
    await writeFile(join(workspaceRoot, "opencode.jsonc"), `${JSON.stringify({ mcp: {} }, null, 2)}\n`, "utf8");

    const allowed = await fetch(`${base}/approvals/${approval.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openwork-host-token": hostToken,
      },
      body: JSON.stringify({ reply: "allow" }),
    });
    expect(allowed.status).toBe(200);

    const response = await pendingPatch;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      changed: boolean;
      enabled: boolean;
      items: Array<{ name: string }>;
    };
    expect(body).toMatchObject({ changed: false, enabled: false });
    expect(body.items.some((entry) => entry.name === "stripe")).toBe(false);

    const audits = await readAuditEntries(workspaceRoot, "ws_1");
    expect(audits).toHaveLength(0);
  });

  test("PATCH rejects invalid payloads and missing MCP apps", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot });

    const invalid = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: "false" }),
    });
    expect(invalid.status).toBe(400);

    const invalidName = await fetch(`${base}/workspace/ws_1/mcp/bad%20name`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(invalidName.status).toBe(400);

    const missing = await fetch(`${base}/workspace/ws_1/mcp/missing`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(missing.status).toBe(404);
  });

  test("PATCH respects read-only OpenWork servers", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot, readOnly: true });

    const response = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(403);

    const audits = await readAuditEntries(workspaceRoot, "ws_1");
    expect(audits).toHaveLength(0);
  });

  test("DELETE rejects inherited global MCP apps without audit or reload", async () => {
    await createGlobalConfigRoot();
    const workspaceRoot = await createWorkspaceRoot();
    const { base, token } = startOpenworkServer({ workspaceRoot });

    const pause = await fetch(`${base}/workspace/ws_1/mcp/inherited`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);

    const auditsBeforeDelete = await readAuditEntries(workspaceRoot, "ws_1");
    const eventsBeforeDelete = await fetch(`${base}/workspace/ws_1/events?since=0`, { headers: auth(token) });
    expect(eventsBeforeDelete.status).toBe(200);
    await eventsBeforeDelete.json();

    const response = await fetch(`${base}/workspace/ws_1/mcp/inherited`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("inherited_mcp_not_removable");

    const auditsAfterDelete = await readAuditEntries(workspaceRoot, "ws_1");
    expect(auditsAfterDelete).toHaveLength(auditsBeforeDelete.length);

    const eventsAfterDelete = await fetch(`${base}/workspace/ws_1/events?since=0`, { headers: auth(token) });
    expect(eventsAfterDelete.status).toBe(200);
    const eventsAfterDeleteBody = (await eventsAfterDelete.json()) as {
      items: Array<{ trigger?: { type?: string; name?: string; action?: string } }>;
    };
    expect(eventsAfterDeleteBody.items).not.toContainEqual(
      expect.objectContaining({
        trigger: { type: "mcp", name: "inherited", action: "removed" },
      }),
    );

    const configText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
    expect(configText).toContain("\"inherited\"");
    expect(configText).toContain("\"enabled\": false");
    expect(configText).not.toContain("global-mcp");
  });

  test("PATCH requires authenticated collaborator access", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const { base, hostToken } = startOpenworkServer({ workspaceRoot });

    const unauthenticated = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(unauthenticated.status).toBe(401);

    const issued = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openwork-host-token": hostToken,
      },
      body: JSON.stringify({ scope: "viewer" }),
    });
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as { token: string };

    const viewer = await fetch(`${base}/workspace/ws_1/mcp/stripe`, {
      method: "PATCH",
      headers: auth(issuedBody.token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(viewer.status).toBe(403);
  });
});
