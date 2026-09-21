import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeV2Server, installOpencodeV2Binary } from "./managed-opencode-v2.js";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

// Characterization of a release blocker, NOT proof of the desired boundary.
// Observe the pinned engine's real provider request instead of reconstructing
// its model catalog from tools/list metadata. See worlds/code-mode-preview.md.
test("pinned v2 direct MCP bypass ignores app-only visibility (release blocker)", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-mode-boundary-"));
  const requests: Record<string, unknown>[] = [];
  const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = record(await request.json());
    if (new URL(request.url).pathname.startsWith("/mcp")) {
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: record(body.params).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "boundary", version: "1" } }
        : body.method === "tools/list" ? { tools: new URL(request.url).pathname === "/mcp-other" ? [
          { name: "read_report", description: "Independent MCP", inputSchema: { type: "object", properties: {} } },
        ] : [
          { name: "execute_capability_script", description: "Run the Den script", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
          { name: "execute_capability", description: "App router", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        ] } : {};
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    requests.push(body);
    const chunk = { id: "boundary", object: "chat.completion.chunk", created: 1, model: "boundary",
      choices: [{ index: 0, delta: { role: "assistant", content: "Boundary observed." }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const bin = await installOpencodeV2Binary(join(tmpdir(), "openwork-code-mode-engine-cache"), artifacts.version);
  const engine = await createManagedOpencodeV2Server({ bin, rootDir: root,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, "config-home"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") } });
  try {
    const directory = root;
    const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => engine.fetchJson(path, { directory, method, body });
    await engine.injectProvider({ id: "boundary", name: "Boundary", apiKey: "synthetic", baseUrl: `${mock.url}v1`, models: [{ id: "boundary", name: "Boundary" }] });
    const added = await api("/api/mcp/openwork-cloud", { config: { type: "remote", url: `${mock.url}mcp`, oauth: false, codemode: false } }, "PUT");
    expect(added.status).toBe(204);
    expect((await api("/api/mcp/independent", { config: { type: "remote", url: `${mock.url}mcp-other`, oauth: false } }, "PUT")).status).toBe(204);
    for (let attempt = 0; attempt < 100; attempt++) {
      const servers = record((await api("/api/mcp")).json).data;
      if (Array.isArray(servers) && servers.length === 2 && servers.every((server) => record(record(server).status).status === "connected")) break;
      await Bun.sleep(100);
    }
    expect(JSON.stringify((await api("/api/mcp")).json)).toContain('"connected"');
    await Bun.sleep(500);
    const created = await api("/api/session", { location: { directory }, model: { providerID: "boundary", id: "boundary" } });
    expect(created.status).toBe(200);
    const id = record(record(created.json).data).id;
    expect(typeof id).toBe("string");
    expect([200, 204]).toContain((await api(`/api/session/${id}/prompt`, { text: "Report the boundary." })).status);
    for (let attempt = 0; attempt < 100 && !requests.some((request) => Array.isArray(request.tools) && request.tools.length); attempt++) {
      await Bun.sleep(100);
    }
    const request = requests.find((request) => Array.isArray(request.tools) && request.tools.length);
    expect(request).toBeDefined();
    const tools = request?.tools;
    if (!Array.isArray(tools)) throw new Error("Missing provider tool catalog");
    const names = tools.map((tool) => record(record(tool).function).name);
    expect(names).toContain("openwork-cloud_execute_capability_script");
    // This is why production mirroring must not enable the bypass yet. Change
    // this to not.toContain only after upgrading/fixing the engine contract.
    expect(names).toContain("openwork-cloud_execute_capability");
    expect(names).not.toContain("independent_read_report");
    const messages = JSON.stringify(request?.messages);
    expect(messages).not.toContain("execute_capability_script");
    expect(messages).toContain("tools.independent.read_report");
  } finally {
    await engine.close();
    mock.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
