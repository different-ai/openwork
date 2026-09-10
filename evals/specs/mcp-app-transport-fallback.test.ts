import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { bootServer, close, isRecord, listen, readBody, sendJson, stopChild } from "../worlds/openwork-server-cli.ts";

// New interoperability journey: a configured MCP App remains discoverable on
// modern and legacy providers, while failed negotiation retains safe diagnostics.
const test = spec.world(async (seed) => {
  const root = seed.tmpPath("mcp-app-transport");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  let status = 200;
  let legacy = false;
  let rejectMethod = "";
  let stream: ServerResponse | undefined;
  const requests: Array<{ http: string; rpc?: string }> = [];
  const secret = "fixture-private-credential";
  const tool = { name: "show", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://fixture/app" } } };
  const provider = createServer(async (request, response) => {
    if (request.method === "GET") {
      requests.push({ http: "GET" });
      if (!legacy) return sendJson(response, 405, { error: secret });
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (request.method !== "POST") return sendJson(response, 405, {});
    const body: unknown = JSON.parse(await readBody(request));
    if (!isRecord(body) || typeof body.method !== "string") return sendJson(response, 400, {});
    requests.push({ http: "POST", rpc: body.method });
    if (rejectMethod === "timeout") return;
    if (rejectMethod === "disconnect") { request.socket.destroy(); return; }
    if (request.url !== "/messages" && body.method === "initialize" && status !== 200) {
      return sendJson(response, status, { error: `${secret} ${"untrusted-provider-body ".repeat(1_000)}` });
    }
    if (body.method === "notifications/initialized") return sendJson(response, rejectMethod === body.method ? 405 : 202, {});
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }
      : body.method === "tools/list" ? { tools: [tool] }
      : body.method === "resources/read" ? { contents: [{ uri: "ui://fixture/app", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Fixture App</p>" }] }
      : { content: [{ type: "text", text: "ok" }] };
    const reply = body.method === rejectMethod
      ? { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Fixture operation rejected" } }
      : { jsonrpc: "2.0", id: body.id, result };
    if (request.url === "/messages") {
      stream?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return sendJson(response, 202, {});
    }
    sendJson(response, 200, reply);
  });
  const providerUrl = await listen(provider);
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({ mcp: {
    fixture: { type: "remote", url: providerUrl, headers: { Authorization: `Bearer ${secret}` }, enabled: true },
  } }));
  const token = "fixture-server-token";
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const booted = bootServer({ ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"), OPENWORK_MANAGE_OPENCODE: "0", OPENWORK_ALLOW_PRIVATE_MCP_URLS: "1",
  }, token, workspace, () => {});
  const dispose = async () => {
    await stopChild(booted.child);
    stream?.end();
    await close(provider);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const base = await booted.listening;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(75_000) });
      const result: unknown = await response.json();
      return { status: response.status, body: result };
    };
    const workspaces = await request("/workspaces");
    if (!isRecord(workspaces.body) || !Array.isArray(workspaces.body.items)
      || !isRecord(workspaces.body.items[0]) || typeof workspaces.body.items[0].id !== "string") throw new Error("Workspace missing");
    const path = `/workspace/${workspaces.body.items[0].id}/mcp-apps`;
    return {
      set(nextStatus: number, nextLegacy = false, rejection = "") {
        status = nextStatus; legacy = nextLegacy; rejectMethod = rejection; requests.length = 0;
      },
      requests: () => requests.slice(),
      catalog: () => request(`${path}/list`),
      resolve: () => request(`${path}/resolve`, { projectedToolName: "fixture_show" }),
      call: () => request(`${path}/call`, { serverName: "fixture", name: "show", resourceUri: "ui://fixture/app" }),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}, { needs: { commands: ["bun"] }, timeout: 180_000 });

test("MCP App transport negotiates legacy only on initialize HTTP 400/404/405 and preserves safe failures", async ({ world, evidence, place }) => {
  console.log(`placement: ${place.kind} (server-boundary journey using isolated CLI and loopback provider)`);
  for (const status of [400, 404, 405]) {
    world.set(status, true);
    expect(await world.resolve()).toMatchObject({ status: 200, body: { app: { html: "<!doctype html><p>Fixture App</p>" } } });
    expect(world.requests().slice(0, 3)).toEqual([{ http: "POST", rpc: "initialize" }, { http: "GET" }, { http: "POST", rpc: "initialize" }]);
    expect(world.requests().filter((request) => request.http === "GET")).toHaveLength(1);
    world.set(status);
    const catalog = await world.catalog();
    expect(catalog).toMatchObject({ status: 200, body: { servers: [{ reachable: false, apps: [],
      error: `Streamable HTTP POST: HTTP ${status}; Legacy SSE fallback: HTTP 405` }] } });
    expect(JSON.stringify(catalog)).not.toContain("fixture-private-credential");
    expect(JSON.stringify(catalog)).not.toContain("untrusted-provider-body");
    expect(world.requests()).toEqual([{ http: "POST", rpc: "initialize" }, { http: "GET" }]);
  }
  evidence.recordAssertionEvidence("Legacy negotiation and safe dual diagnostics", "Initialize HTTP 400/404/405 each resolved a real App through SSE; failed GET retained both statuses without echoed credentials or provider bodies.", true);
  for (const status of [401, 403, 408, 429, 500, 502, 503]) {
    world.set(status);
    expect(await world.catalog()).toMatchObject({ status: 200, body: { servers: [{ reachable: false, apps: [], error: `Streamable HTTP POST: HTTP ${status}` }] } });
    expect(world.requests()).toEqual([{ http: "POST", rpc: "initialize" }]);
  }
  world.set(200, false, "initialize");
  expect(await world.catalog()).toMatchObject({ body: { servers: [{ reachable: false, error: "Streamable HTTP POST: MCP initialization rejected" }] } });
  expect(world.requests()).toEqual([{ http: "POST", rpc: "initialize" }]);
  world.set(200, false, "notifications/initialized");
  expect(await world.catalog()).toMatchObject({ body: { servers: [{ reachable: false, error: "Streamable HTTP POST: HTTP 405" }] } });
  expect(world.requests()).toEqual([{ http: "POST", rpc: "initialize" }, { http: "POST", rpc: "notifications/initialized" }]);
  evidence.recordAssertionEvidence("No retry outside initialize HTTP negotiation", "Authentication, timeout HTTP status, rate limit, upstream errors, JSON-RPC rejection and initialized-notification 405 issued no legacy GET.", true);
  world.set(200);
  expect(await world.catalog()).toMatchObject({ body: { servers: [{ reachable: true, apps: [{ toolName: "show" }] }] } });
  expect(world.requests().filter((request) => request.rpc === "initialize")).toHaveLength(1);
  expect(world.requests().filter((request) => request.http === "GET")).toHaveLength(1);
  world.set(200, false, "tools/call");
  const call = await world.call();
  expect(call.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(call.body)).toContain("Fixture operation rejected");
  expect(world.requests().filter((request) => request.rpc === "initialize")).toHaveLength(1);
  expect(world.requests().filter((request) => request.rpc === "tools/call")).toHaveLength(1);
  expect(world.requests().filter((request) => request.http === "GET")).toHaveLength(1);
  evidence.recordAssertionEvidence("Optional GET 405 and connected tool errors do not switch transports", "Modern catalog remains reachable after optional GET 405; rejected tool executed once with one initialization and only the optional GET.", true);
  world.set(200, false, "disconnect");
  const disconnected = await world.resolve();
  expect(disconnected.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(disconnected.body)).toContain("Streamable HTTP POST:");
  // The HTTP runtime may retry a reset socket; it must never switch to GET/SSE.
  expect(world.requests().length).toBeGreaterThan(0);
  expect(world.requests().every((request) => request.http === "POST" && request.rpc === "initialize")).toBe(true);
  world.set(200, false, "timeout");
  const timedOut = await world.resolve();
  expect(timedOut).toMatchObject({ status: 502, body: { code: "mcp_unreachable", message: "Streamable HTTP POST: request timed out" } });
  expect(world.requests().filter((request) => request.rpc === "initialize")).toHaveLength(1);
  expect(world.requests().filter((request) => request.http === "GET")).toHaveLength(0);
  evidence.recordAssertionEvidence("Network disconnect and actual initialization timeout do not retry SSE", "An abruptly closed socket and an unanswered InitializeRequest both failed through resolve with zero GETs; SDK timeout retained its fixed diagnostic.", true);
});
