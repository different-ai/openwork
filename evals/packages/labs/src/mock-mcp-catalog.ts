import { createServer } from "node:http";
import { close, isRecord, listen, readBody, sendJson } from "../../../worlds/openwork-server-cli.ts";

/** Isolated wire witness for desktop catalog discovery, not a product implementation. */
export async function startCatalogWitness(privateAuthorization: string) {
  let catalogText = JSON.stringify({ schemaVersion: "openwork.connect/mcp-servers/1", servers: [] });
  let catalogStatus = 200;
  let catalogFailures = 0;
  let catalogHold: { entered: () => void; released: Promise<void> } | undefined;
  const appCalls: string[] = [];
  const requests: Array<{ method: string; privateAuth: boolean; appHostCapability: boolean }> = [];
  const registrations: Array<{ name: string; privateAuth: boolean }> = [];
  const disconnects: string[] = [];
  const connected = new Set<string>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const raw = request.method === "POST" ? await readBody(request) : "";
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const body = isRecord(parsed) ? parsed : {};
    if (path === "/mcp/agent") {
      const privateAuth = request.headers.authorization === privateAuthorization;
      const method = typeof body.method === "string" ? body.method : "";
      requests.push({ method, privateAuth, appHostCapability: request.headers["x-openwork-mcp-client-capabilities"] === "mcp-app-host-v1" });
      if (privateAuth && catalogStatus !== 200) return sendJson(response, catalogStatus, { error: "catalog unavailable" });
      if (privateAuth && method === "resources/read" && catalogFailures > 0) {
        catalogFailures -= 1;
        return sendJson(response, 503, { error: "catalog warming up" });
      }
      if (privateAuth && method === "resources/read" && catalogHold) {
        const hold = catalogHold;
        catalogHold = undefined;
        hold.entered();
        await hold.released;
      }
      if (method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result = method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { resources: {}, tools: {} }, serverInfo: { name: "catalog-witness", version: "1" } }
        : method === "resources/read"
          ? { contents: [{ uri: "openwork://connect/mcp-servers/index.json", mimeType: "application/json", text: catalogText }] }
          : { tools: ["search_capabilities", "execute_capability"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) };
      return sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result });
    }
    if (path === "/mcp/agent/connections/catalog-connection") {
      if (request.method !== "POST") return response.writeHead(405).end();
      if (request.headers.authorization !== privateAuthorization) return sendJson(response, 401, { error: "unauthorized" });
      if (body.method === "notifications/initialized") return response.writeHead(202).end();
      if (body.method === "tools/call") appCalls.push(isRecord(body.params) ? String(body.params.name) : "");
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { resources: {}, tools: {} }, serverInfo: { name: "catalog-app", version: "1" } }
        : body.method === "tools/list"
          ? { tools: [{ name: "show", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://fixture/app" } } }] }
          : body.method === "resources/read"
            ? { contents: [{ uri: "ui://fixture/app", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Catalog App</p>" }] }
            : { content: [{ type: "text", text: "Catalog App data" }] };
      return sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result });
    }
    if (path === "/mcp" && request.method === "POST") {
      if (typeof body.name === "string") {
        connected.add(body.name);
        registrations.push({ name: body.name, privateAuth: raw.includes(privateAuthorization) });
      }
      return sendJson(response, 200, Object.fromEntries([...connected].map((name) => [name, { status: "connected" }])));
    }
    if (path.startsWith("/mcp/") && path.endsWith("/disconnect")) {
      const name = decodeURIComponent(path.split("/")[2] ?? "");
      connected.delete(name);
      disconnects.push(name);
      return sendJson(response, 200, true);
    }
    if (path === "/mcp") return sendJson(response, 200, Object.fromEntries([...connected].map((name) => [name, { status: "connected" }])));
    if (path === "/global/health") return sendJson(response, 200, { healthy: true, version: "1.17.11" });
    if (path === "/experimental/tool/ids") return sendJson(response, 200, ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability", "openwork_docs_search", "openwork_query"]);
    if (path === "/provider") return sendJson(response, 200, { all: [], default: {}, connected: [] });
    if (path === "/session" || path === "/experimental/tool") return sendJson(response, 200, []);
    return sendJson(response, 200, {});
  });
  const url = await listen(server);
  return {
    url, requests, registrations, disconnects, appCalls,
    catalog(text: string, status = 200) { catalogText = text; catalogStatus = status; catalogFailures = 0; },
    failNextCatalogReads(count: number) { catalogFailures = count; },
    holdNextCatalogRead() {
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      catalogHold = { entered, released };
      return { started, release };
    },
    stop: () => close(server),
  };
}
