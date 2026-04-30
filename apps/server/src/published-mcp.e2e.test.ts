import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const HOST_TOKEN = "owt_published_host_token";
const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];
const fakeOpencodeStops: Array<() => void> = [];
const priorPublishedStore = process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE;
const priorTokenStore = process.env.OPENWORK_TOKEN_STORE;

type FakeOpencode = {
  url: string;
  promptCalls: Array<{ sessionId: string; body: unknown }>;
  stop: () => void;
};

function startFakeOpencode(): FakeOpencode {
  const promptCalls: FakeOpencode["promptCalls"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: "sess_test_1", title: "MCP test" });
      }
      // Real OpenCode exposes the synchronous prompt at `/session/:id/message`
      // (POST). Match that path so the e2e covers the same wire shape we ship.
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "POST" && promptMatch) {
        const body = await request.json().catch(() => null);
        promptCalls.push({ sessionId: promptMatch[1], body });
        return Response.json({
          info: { id: "msg_test_1", role: "assistant" },
          parts: [{ type: "text", text: "Echo: ok" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const stop = () => (server as unknown as { stop: (force?: boolean) => void }).stop(true);
  fakeOpencodeStops.push(stop);
  return { url: `http://127.0.0.1:${(server as unknown as { port: number }).port}`, promptCalls, stop };
}

function baseConfig(workspace: WorkspaceInfo): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_published_client_token",
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspace.path],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
}

function bootWith(workspace: WorkspaceInfo) {
  const server = startServer(baseConfig(workspace)) as Served;
  stops.push(() => server.stop(true));
  return { server, base: `http://127.0.0.1:${server.port}` };
}

function hostAuth() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-published-mcp-"));
  dirs.push(dir);
  process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE = join(dir, "published.json");
  process.env.OPENWORK_TOKEN_STORE = join(dir, "tokens.json");
});

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (fakeOpencodeStops.length) fakeOpencodeStops.pop()?.();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (priorPublishedStore === undefined) delete process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE;
  else process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE = priorPublishedStore;
  if (priorTokenStore === undefined) delete process.env.OPENWORK_TOKEN_STORE;
  else process.env.OPENWORK_TOKEN_STORE = priorTokenStore;
});

function makeWorkspace(opencodeUrl: string): WorkspaceInfo {
  const dir = mkdtempSync(join(tmpdir(), "openwork-published-ws-"));
  dirs.push(dir);
  return {
    id: "ws_test",
    name: "test",
    path: dir,
    preset: "default",
    workspaceType: "local",
    baseUrl: opencodeUrl,
    directory: dir,
  } as WorkspaceInfo;
}

describe("published workflows + MCP", () => {
  test("admin create issues a token and lists the workflow", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);

    const issued = await fetch(`${base}/workspace/${ws.id}/published-workflows`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ skillName: "summarize", description: "Summarize input" }),
    });
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as { id: string; token: string; toolName: string };
    expect(body.token).toMatch(/^pwt_/);
    expect(body.toolName).toBe("summarize");

    const listed = await fetch(`${base}/workspace/${ws.id}/published-workflows`, { headers: hostAuth() });
    const list = (await listed.json()) as { items: Array<{ id: string }> };
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe(body.id);
  });

  test("admin create rejects missing skillName", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const res = await fetch(`${base}/workspace/${ws.id}/published-workflows`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ description: "no skill" }),
    });
    expect(res.status).toBe(400);
  });

  test("MCP transport rejects unknown tokens", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const res = await fetch(`${base}/published/not-a-real-token/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  async function publish(base: string, ws: WorkspaceInfo) {
    const res = await fetch(`${base}/workspace/${ws.id}/published-workflows`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ skillName: "summarize", description: "Summarize input text" }),
    });
    const body = (await res.json()) as { token: string; id: string; toolName: string };
    return body;
  }

  test("MCP initialize returns protocol version + serverInfo", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const res = await fetch(`${base}/published/${issued.token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    expect(body.result?.protocolVersion).toBe("2024-11-05");
    expect(body.result?.serverInfo.name).toBe("openwork-published-workflow");
  });

  test("MCP tools/list exposes the published tool", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const res = await fetch(`${base}/published/${issued.token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(body.result.tools.length).toBe(1);
    expect(body.result.tools[0].name).toBe("summarize");
    expect(body.result.tools[0].description).toBe("Summarize input text");
  });

  test("MCP tools/call invokes OpenCode and returns the assistant text", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const res = await fetch(`${base}/published/${issued.token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "summarize", arguments: { input: "hello world" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].type).toBe("text");
    expect(body.result.content[0].text).toBe("Echo: ok");

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].sessionId).toBe("sess_test_1");
  });

  test("MCP tools/call rejects unknown tool name with INVALID_PARAMS", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const res = await fetch(`${base}/published/${issued.token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ghost", arguments: {} },
      }),
    });
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32602);
  });

  test("MCP DELETE returns 204 (stateless terminate)", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const res = await fetch(`${base}/published/${issued.token}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("revoke breaks the MCP token", async () => {
    const fake = startFakeOpencode();
    const ws = makeWorkspace(fake.url);
    const { base } = bootWith(ws);
    const issued = await publish(base, ws);

    const del = await fetch(`${base}/workspace/${ws.id}/published-workflows/${issued.id}`, {
      method: "DELETE",
      headers: hostAuth(),
    });
    expect(del.status).toBe(200);

    const after = await fetch(`${base}/published/${issued.token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(after.status).toBe(401);
  });
});
