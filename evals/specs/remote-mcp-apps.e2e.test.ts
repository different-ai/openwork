import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, createAndSelectWorkspace, createOrgConnection, denFetch, evalIn, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets, navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome, desktop } from "@openwork/hosts";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";
import { buildGeneratedArtifactViewInWorker } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "Remote MCP Apps skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "Remote MCP Apps skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "Remote MCP Apps skipped — needs MySQL on 127.0.0.1:3306"
      : "standard MCP Apps refresh after connection changes while standalone URL Apps remain unavailable";
const providerId = "remote-mcp-apps-provider";
const modelId = "remote-mcp-apps-model";
const desktopClosingReply = "Project Atlas is open through its standard MCP server.";
const connectedResourceUri = "ui://project-atlas/view.html";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

async function waitForMountedProjectAtlas(
  app: Awaited<ReturnType<typeof desktop>>,
  expected: string[] = ["Project Atlas", "Connected through OpenWork Connect"],
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(app.handle.cdpUrl);
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl);
    if (sandbox) {
      const client = await connect(debuggerUrlFor(app.handle.cdpUrl, sandbox));
      try {
        const mounted = await evaluate(client, `(() => {
          const text = document.querySelector("iframe")?.contentDocument?.body?.innerText ?? "";
          return ${JSON.stringify(expected)}.every((value) => text.includes(value));
        })()`);
        if (mounted === true) return true;
      } finally {
        client.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function forwardedMcpHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "x-openwork-mcp-client-audience",
    "x-openwork-mcp-client-capabilities",
  ]) {
    const value = requestHeader(request, name);
    if (value) headers[name] = value;
  }
  return headers;
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-remote-mcp-apps",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let delay = 250;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
    delay += 250;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay);
}

function toolResultCount(payload: Record<string, unknown>) {
  return Array.isArray(payload.messages)
    ? payload.messages.filter((message) => isRecord(message) && message.role === "tool").length
    : 0;
}

function projectedToolEnding(payload: Record<string, unknown>, ending: string) {
  if (!Array.isArray(payload.tools)) return null;
  for (const tool of payload.tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const name = tool.function.name;
    if (typeof name === "string" && name.endsWith(ending)) return name;
  }
  return null;
}

function projectedToolNames(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.tools)) return [];
  return payload.tools.flatMap((tool) => (
    isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string"
      ? [tool.function.name]
      : []
  ));
}

const builtPortableApp = await buildGeneratedArtifactViewInWorker({
  reactSource: `export default function ProjectAtlas(props) {
    const app = props.data || props.app || { name: "Project Atlas", status: "Portable standard MCP App resource" };
    return <main><p className="eyebrow">REMOTE MCP APP</p><h1>{app.name}</h1><p>Cached immutable revision</p><p>{app.status}</p></main>;
  }`,
  cssSource: "body{margin:0;padding:18px;color:#172033;background:#f5f7fb;font-family:system-ui,sans-serif}main{padding:22px;border:1px solid #dbe4f0;border-radius:16px;background:white}.eyebrow{color:#2563eb;font-size:11px;font-weight:700;letter-spacing:.12em}h1{margin:8px 0;font-size:24px}p{margin:6px 0}",
  outputSchema: { type: "object", additionalProperties: true },
  title: "Project Atlas",
  description: "A portable Remote MCP App acceptance fixture.",
});
if (!builtPortableApp.ok) throw new Error(`Portable app build failed: ${JSON.stringify(builtPortableApp.diagnostics)}`);
const portableAppDocument = builtPortableApp.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, "");

function connectedAppHtml(version: string): string {
  return portableAppDocument.replace(
    "</body>",
    `<!-- Portable revision ${version} --></body>`,
  );
}

function standardMcpAppRpc(message: Record<string, unknown>): Record<string, unknown> {
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
        serverInfo: {
          name: "project-atlas-connect-fixture",
          title: "Project Atlas Connect",
          version: "1.0.0",
          description: "A standard MCP App fixture served through OpenWork Connect.",
          websiteUrl: "https://example.test/project-atlas",
          icons: [{ src: "https://example.test/project-atlas.png", mimeType: "image/png", sizes: ["64x64"] }],
        },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "open_project_atlas",
            title: "Open Project Atlas",
            description: "Open the Project Atlas MCP App.",
            inputSchema: { type: "object", additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { ui: { resourceUri: connectedResourceUri } },
          },
          {
            name: "search_projects",
            title: "Search projects",
            description: "Search the connected project catalog.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    };
  }
  if (message.method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { resources: [] },
    };
  }
  if (message.method === "resources/templates/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { resourceTemplates: [] },
    };
  }
  if (message.method === "resources/read") {
    const params = requireRecord(message.params, "resources/read params");
    if (params.uri !== connectedResourceUri) {
      return { jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found" } };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: connectedResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: connectedAppHtml("Connect 1.0.0"),
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [] },
              prefersBorder: true,
            },
          },
        }],
      },
    };
  }
  if (message.method === "tools/call") {
    const params = requireRecord(message.params, "tools/call params");
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (params.name === "open_project_atlas") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "Project Atlas opened." }],
          structuredContent: {
            schemaVersion: "1",
            artifact: { title: "Project Atlas", description: "A standard MCP App served through OpenWork Connect." },
            data: { name: "Project Atlas", status: "Connected through OpenWork Connect" },
          },
          _meta: { source: "project-atlas-standard-mcp" },
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `Atlas project result for ${String(args.query ?? "all")}` }],
        structuredContent: {
          projects: [{ id: "project-atlas", name: "Atlas migration", status: "on_track" }],
        },
        _meta: { source: "project-atlas-standard-mcp" },
      },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: {} };
}

let agentRequestId = 0;

async function agentRpc(
  apiUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  endpoint = "/mcp/agent",
  extraHeaders: Record<string, string> = {},
) {
  const id = ++agentRequestId;
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const payload = raw.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown)
    .find((candidate) => isRecord(candidate) && candidate.id === id);
  const message = requireRecord(payload, `${method} response`);
  if (message.error) throw new Error(`MCP ${method} returned ${JSON.stringify(message.error)}`);
  return requireRecord(message.result, `${method} result`);
}

function toolsFrom(result: Record<string, unknown>) {
  return Array.isArray(result.tools) ? result.tools.filter(isRecord) : [];
}

function contentsFrom(result: Record<string, unknown>) {
  return Array.isArray(result.contents) ? result.contents.filter(isRecord) : [];
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, { timeout: 360_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  process.env.DEN_REMOTE_MCP_APPS_ENABLED = "true";

  let standardMcpCalls = 0;
  let agentMcpUpstream: { token: string; staticUrl: string; connectedUrl: string } | null = null;
  let gatewayCapabilityName: string | null = null;
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const payload = requireRecord(JSON.parse(await readBody(request)), "chat completion request");
        if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
          sendStream(response, [streamChunk({ role: "assistant" }), streamChunk({ content: "Project Atlas" }), streamChunk({}, "stop")]);
          return;
        }
        const directProviderTools = projectedToolNames(payload).filter((name) => (
          name.includes("open_project_atlas")
          || name.includes("search_projects")
          || name.includes("launch_remote_app_")
          || name.includes("import_remote_mcp_app")
          || name.includes("openwork_connect_")
        ));
        if (directProviderTools.length > 0) {
          throw new Error(`Provider MCP tools leaked into the model tool list: ${directProviderTools.join(", ")}`);
        }
        const completedTools = toolResultCount(payload);
        if (completedTools > 1) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: desktopClosingReply }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        const toolName = projectedToolEnding(payload, completedTools === 0 ? "_search_capabilities" : "_execute_capability");
        if (!toolName) throw new Error("The Remote MCP App capability gateway tools were not projected to the model.");
        if (completedTools === 1 && !gatewayCapabilityName) {
          throw new Error("The Project Atlas gateway capability was not configured.");
        }
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({
            tool_calls: [{
              index: 0,
              id: "call_project_atlas",
              type: "function",
              function: {
                name: toolName,
                arguments: completedTools === 0
                  ? JSON.stringify({ query: "open Project Atlas", type: "mcp", limit: 5 })
                  : JSON.stringify({
                      name: gatewayCapabilityName,
                      body: {},
                    }),
              },
            }],
          }),
          streamChunk({}, "tool_calls"),
        ]);
        return;
      }
      if (url.pathname === "/agent-mcp"
        || url.pathname === "/connected-mcp"
        || url.pathname === "/mcp/agent"
        || url.pathname.startsWith("/mcp/agent/connections/")) {
        if (!agentMcpUpstream) throw new Error("The Den agent MCP proxy was not configured.");
        const raw = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
        const upstream = await fetch(
          url.pathname === "/connected-mcp" || url.pathname.startsWith("/mcp/agent/connections/")
            ? agentMcpUpstream.connectedUrl
            : agentMcpUpstream.staticUrl,
          {
          method: request.method,
          headers: {
            authorization: request.headers.authorization ?? `Bearer ${agentMcpUpstream.token}`,
            accept: request.headers.accept ?? "application/json, text/event-stream",
            ...forwardedMcpHeaders(request),
          },
          body: raw || undefined,
          },
        );
        const body = Buffer.from(await upstream.arrayBuffer());
        let method = "";
        try {
          const message: unknown = raw ? JSON.parse(raw) : null;
          if (isRecord(message) && typeof message.method === "string") method = message.method;
        } catch {
          // The upstream Den endpoint remains responsible for invalid JSON.
        }
        if (method === "tools/call") {
          // Match a normal remote round trip so the completed tool event stays
          // inside Desktop's live renderer subscription window.
          await new Promise((resolve) => setTimeout(resolve, 4_000));
        }
        const headers: Record<string, string> = {};
        for (const name of ["cache-control", "content-type", "mcp-session-id"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(upstream.status, headers);
        response.end(body);
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.method === "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const raw = await readBody(request);
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies: Record<string, unknown>[] = [];
        for (const candidate of messages) {
          if (!isRecord(candidate)) continue;
          if (candidate.method === "tools/call") standardMcpCalls += 1;
          if (candidate.id !== undefined) replies.push(standardMcpAppRpc(candidate));
        }
        if (replies.length === 0) {
          response.writeHead(202, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
  });
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Remote MCP App fixture did not bind a port.");
  const fixtureUrl = `http://127.0.0.1:${address.port}`;

  await using den = await server({
    place,
    org: { name: `Remote MCP Apps ${Date.now()}`, admin: { name: "Avery" } },
  });
  const orgsResult = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const orgs = isRecord(orgsResult.body) && Array.isArray(orgsResult.body.orgs)
    ? orgsResult.body.orgs.filter(isRecord)
    : [];
  const organizationId = String(orgs[0]?.id ?? "");
  expect(organizationId).not.toBe("");
  const enabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { remoteMcpApps: true } }),
  });
  expect(enabled.response.ok, enabled.text).toBe(true);

  const connection = await createOrgConnection(den.admin, {
    name: "Atlas read-only projects",
    url: `${fixtureUrl}/mcp`,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  gatewayCapabilityName = `mcp:${connection.id}:open_project_atlas`;

  const tokenResult = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(tokenResult.response.ok, tokenResult.text).toBe(true);
  const mcpTokenBody = requireRecord(tokenResult.body, "MCP token response");
  const mcpToken = String(mcpTokenBody.token ?? "");
  const appHostMcpToken = String(mcpTokenBody.appHostToken ?? "");
  expect(appHostMcpToken).not.toBe(mcpToken);
  const connectedEndpoint = `/mcp/agent/connections/${encodeURIComponent(connection.id)}`;
  const appHostCapabilityHeaders = { "x-openwork-mcp-client-capabilities": "mcp-app-host-v1" };
  const appHostHeaders = appHostCapabilityHeaders;
  agentMcpUpstream = {
    token: mcpToken,
    staticUrl: `${den.ref.apiUrl}/mcp/agent`,
    connectedUrl: `${den.ref.apiUrl}${connectedEndpoint}`,
  };

  const initialized = await agentRpc(den.ref.apiUrl, mcpToken, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    clientInfo: { name: "remote-mcp-app-eval", version: "1.0.0" },
  });
  expect(initialized.protocolVersion).toBeTruthy();
  expect(String(initialized.instructions ?? "")).toContain("URL-imported Apps are deferred");
  const initializedCapabilities = requireRecord(initialized.capabilities, "agent capabilities");
  expect(requireRecord(initializedCapabilities.tools, "agent tool capabilities").listChanged).toBe(true);
  expect(requireRecord(initializedCapabilities.resources, "agent resource capabilities").listChanged).toBe(true);

  const centralModelTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {});
  const centralModelToolNames = toolsFrom(centralModelTools).map((tool) => String(tool.name ?? ""));
  expect(centralModelToolNames).not.toContain("import_remote_mcp_app");
  expect(centralModelToolNames.some((name) => name.startsWith("launch_remote_app_"))).toBe(false);
  const centralAppHostTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {}, "/mcp/agent", appHostHeaders);
  const centralAppHostToolNames = toolsFrom(centralAppHostTools).map((tool) => String(tool.name ?? ""));
  expect(centralAppHostToolNames).not.toContain("import_remote_mcp_app");
  expect(centralAppHostToolNames.some((name) => name.startsWith("launch_remote_app_"))).toBe(false);

  const unavailableImport = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "import_remote_mcp_app",
    arguments: { sourceUrl: "https://example.test/project-atlas.html" },
  });
  expect(unavailableImport.isError).toBe(true);

  const unavailableImportApi = await denFetch(den.admin, "/v1/remote-mcp-apps", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ sourceUrl: "https://example.test/project-atlas.html" }),
  });
  expect(unavailableImportApi.response.status).toBe(404);
  const unavailablePreviewApi = await denFetch(den.admin, "/v1/remote-mcp-apps/preview", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ sourceUrl: "https://example.test/project-atlas.html" }),
  });
  expect(unavailablePreviewApi.response.status).toBe(404);

  await using browser = await chrome({ name: "remote-mcp-apps", startUrl: den.ref.webUrl, headless: true });
  await navigate(browser.client, den.ref.webUrl);
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library`);
  await waitFor(browser, `document.body.innerText.includes("My Library")`, {
    timeoutMs: 60_000,
    label: "Library without standalone URL-App import",
  });
  const libraryDom = await evalIn(browser, `({
    text: document.body.innerText,
    addButton: Boolean(document.querySelector('[data-testid="add-remote-mcp-app"]')),
    urlInput: Boolean(document.querySelector('input[type="url"]')),
  })`);
  const libraryState = requireRecord(libraryDom, "Library DOM state");
  expect(libraryState.addButton).toBe(false);
  expect(libraryState.urlInput).toBe(false);
  expect(String(libraryState.text)).not.toContain("Add remote MCP App");

  const standaloneSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "open standalone URL-installed Project Atlas", type: "mcp", limit: 10 },
  });
  const standaloneMatches = Array.isArray(requireRecord(standaloneSearch.structuredContent, "standalone App search").matches)
    ? (requireRecord(standaloneSearch.structuredContent, "standalone App search").matches as unknown[]).filter(isRecord)
    : [];
  expect(standaloneMatches.some((match) => String(match.name ?? "").startsWith("remote_app:"))).toBe(false);
  expect(JSON.stringify(standaloneMatches)).not.toContain("ui://openwork/library-apps/");

  const connectSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "Atlas read-only projects", type: "mcp", limit: 5 },
  });
  const connectMatches = Array.isArray(requireRecord(connectSearch.structuredContent, "Connect search").matches)
    ? (requireRecord(connectSearch.structuredContent, "Connect search").matches as unknown[]).filter(isRecord)
    : [];
  const connectMatch = requireRecord(connectMatches.find((match) => String(match.name ?? "").includes("search_projects")), "Connect capability match");
  const connectRun = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: connectMatch.name, schemaDigest: connectMatch.schemaDigest, body: { query: "migration" } },
  });
  expect(connectRun.isError, JSON.stringify(connectRun)).not.toBe(true);
  expect(JSON.stringify(connectRun.structuredContent)).toContain("Atlas migration");
  expect(standardMcpCalls).toBe(1);

  const appSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "open Project Atlas", type: "mcp", limit: 5 },
  });
  const appMatches = Array.isArray(requireRecord(appSearch.structuredContent, "MCP App search").matches)
    ? (requireRecord(appSearch.structuredContent, "MCP App search").matches as unknown[]).filter(isRecord)
    : [];
  expect(appMatches.find((match) => match.name === gatewayCapabilityName)).toMatchObject({
    kind: "mcp_app",
    mcpApp: { resourceUri: connectedResourceUri },
  });

  const resources = await agentRpc(den.ref.apiUrl, mcpToken, "resources/list", {});
  expect(Array.isArray(resources.resources) && resources.resources.some((resource) => isRecord(resource) && String(resource.uri ?? "").startsWith("ui://openwork/library-apps/"))).toBe(false);
  expect(Array.isArray(resources.resources) && resources.resources.some((resource) => isRecord(resource) && resource.uri === "openwork://connect/mcp-servers/index.json")).toBe(true);
  const legacyConnectIndexRead = await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: "openwork://connect/mcp-servers/index.json" });
  const legacyConnectIndex = requireRecord(JSON.parse(String(contentsFrom(legacyConnectIndexRead)[0]?.text ?? "{}")), "legacy Connect MCP server index");
  expect(legacyConnectIndex.servers).toEqual([]);
  const connectIndexRead = await agentRpc(
    den.ref.apiUrl,
    appHostMcpToken,
    "resources/read",
    { uri: "openwork://connect/mcp-servers/index.json" },
    "/mcp/agent",
    appHostCapabilityHeaders,
  );
  const connectIndex = requireRecord(JSON.parse(String(contentsFrom(connectIndexRead)[0]?.text ?? "{}")), "Connect MCP server index");
  const indexedServers = Array.isArray(connectIndex.servers) ? connectIndex.servers.filter(isRecord) : [];
  expect(indexedServers).toContainEqual(expect.objectContaining({
    connectionId: connection.id,
    url: `${den.ref.apiUrl}/mcp/agent/connections/${connection.id}`,
  }));
  const connectedInitialized = await agentRpc(den.ref.apiUrl, appHostMcpToken, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    clientInfo: { name: "remote-mcp-app-connect-eval", version: "1.0.0" },
  }, connectedEndpoint, appHostHeaders);
  expect(requireRecord(connectedInitialized.capabilities, "connected capabilities").extensions).toBeTruthy();
  expect(requireRecord(connectedInitialized.serverInfo, "connected server info")).toEqual({
    name: "project-atlas-connect-fixture",
    title: "Project Atlas Connect",
    version: "1.0.0",
    description: "A standard MCP App fixture served through OpenWork Connect.",
    websiteUrl: "https://example.test/project-atlas",
    icons: [{ src: "https://example.test/project-atlas.png", mimeType: "image/png", sizes: ["64x64"] }],
  });

  const modelConnectedTools = await agentRpc(
    den.ref.apiUrl,
    mcpToken,
    "tools/list",
    {},
    connectedEndpoint,
    appHostCapabilityHeaders,
  );
  expect(toolsFrom(modelConnectedTools).map((tool) => tool.name)).toEqual([
    "search_capabilities",
    "execute_capability",
  ]);
  const legacyConnectedTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {}, connectedEndpoint);
  expect(toolsFrom(legacyConnectedTools).map((tool) => tool.name)).toEqual([
    "search_capabilities",
    "execute_capability",
  ]);
  for (const tool of [...toolsFrom(modelConnectedTools), ...toolsFrom(legacyConnectedTools)]) {
    expect(tool._meta).toBeUndefined();
  }
  const legacyConnectedResources = await agentRpc(den.ref.apiUrl, mcpToken, "resources/list", {}, connectedEndpoint);
  expect(legacyConnectedResources.resources).toEqual([]);
  const legacyConnectedTemplates = await agentRpc(den.ref.apiUrl, mcpToken, "resources/templates/list", {}, connectedEndpoint);
  expect(legacyConnectedTemplates.resourceTemplates).toEqual([]);
  const legacyProviderSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "Atlas project catalog", limit: 5 },
  }, connectedEndpoint);
  const legacyProviderMatches = Array.isArray(requireRecord(legacyProviderSearch.structuredContent, "legacy provider search").matches)
    ? (requireRecord(legacyProviderSearch.structuredContent, "legacy provider search").matches as unknown[]).filter(isRecord)
    : [];
  expect(legacyProviderMatches).toContainEqual(expect.objectContaining({ name: "search_projects" }));
  expect(legacyProviderMatches.every((match) => match.kind === undefined && match.mcpApp === undefined)).toBe(true);
  const connectedToolsResult = await agentRpc(den.ref.apiUrl, appHostMcpToken, "tools/list", {}, connectedEndpoint, appHostHeaders);
  const connectedTools = toolsFrom(connectedToolsResult);
  expect(connectedTools.map((tool) => tool.name)).toEqual([
    "search_capabilities",
    "execute_capability",
    "open_project_atlas",
  ]);
  for (const tool of connectedTools) {
    expect(requireRecord(requireRecord(tool._meta, "connected tool metadata").ui, "connected UI metadata").visibility).toEqual(["app"]);
  }
  const connectedOpenTool = requireRecord(connectedTools.find((tool) => tool.name === "open_project_atlas"), "connected open tool");
  expect(requireRecord(requireRecord(connectedOpenTool._meta, "connected tool metadata").ui, "connected UI metadata")).toMatchObject({
    resourceUri: connectedResourceUri,
    visibility: ["app"],
  });

  const connectedResources = await agentRpc(
    den.ref.apiUrl,
    mcpToken,
    "resources/list",
    {},
    connectedEndpoint,
    appHostCapabilityHeaders,
  );
  expect(connectedResources.resources).toEqual([]);
  await expect(agentRpc(
    den.ref.apiUrl,
    mcpToken,
    "resources/read",
    { uri: connectedResourceUri },
    connectedEndpoint,
    appHostCapabilityHeaders,
  ))
    .rejects.toThrow("only through the OpenWork App host");
  const connectedRead = await agentRpc(
    den.ref.apiUrl,
    appHostMcpToken,
    "resources/read",
    { uri: connectedResourceUri },
    connectedEndpoint,
    appHostHeaders,
  );
  const connectedContent = requireRecord(contentsFrom(connectedRead)[0], "connected resource");
  expect(connectedContent.mimeType).toBe("text/html;profile=mcp-app");
  expect(String(connectedContent.text ?? "")).toContain("Project Atlas");
  expect(String(connectedContent.text ?? "")).toContain("Portable revision Connect 1.0.0");
  expect(requireRecord(requireRecord(connectedContent._meta, "connected resource metadata").ui, "connected resource UI metadata").csp).toBeTruthy();

  await expect(agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_projects",
    arguments: { query: "migration" },
  }, connectedEndpoint, appHostCapabilityHeaders)).rejects.toThrow("Use search_capabilities and execute_capability");
  await expect(agentRpc(den.ref.apiUrl, appHostMcpToken, "tools/call", {
    name: "search_projects",
    arguments: { query: "migration" },
  }, connectedEndpoint, appHostHeaders)).rejects.toThrow("Use search_capabilities and execute_capability");
  const providerAppSearch = await agentRpc(den.ref.apiUrl, appHostMcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "Atlas project catalog", limit: 5 },
  }, connectedEndpoint, appHostHeaders);
  const providerAppMatches = Array.isArray(requireRecord(providerAppSearch.structuredContent, "provider App search").matches)
    ? (requireRecord(providerAppSearch.structuredContent, "provider App search").matches as unknown[]).filter(isRecord)
    : [];
  expect(providerAppMatches).toContainEqual(expect.objectContaining({ name: "search_projects" }));
  const providerAppRun = await agentRpc(den.ref.apiUrl, appHostMcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: "search_projects", body: { query: "migration" } },
  }, connectedEndpoint, appHostHeaders);
  expect(JSON.stringify(providerAppRun.structuredContent)).toContain("Atlas migration");
  expect(standardMcpCalls).toBe(2);

  await using desktopApp = await desktop({
    name: "remote-mcp-apps",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  });
  const workspace = await createAndSelectWorkspace(desktopApp, {
    path: `/tmp/openwork-remote-mcp-apps-${Date.now()}`,
  });
  const configured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Remote MCP Apps model",
              options: { baseURL: ${JSON.stringify(`${fixtureUrl}/v1`)}, apiKey: "sk-remote-mcp-apps" },
              models: { [${JSON.stringify(modelId)}]: { name: "Remote MCP Apps model", tool_call: true } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
    const reconcileResponse = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/mcp/openwork-cloud/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          type: "remote",
          url: ${JSON.stringify(`${den.ref.apiUrl}/mcp/agent`)},
          enabled: true,
          headers: { Authorization: ${JSON.stringify(`Bearer ${mcpToken}`)} },
          oauth: false,
        },
        appHostAuthorization: ${JSON.stringify(`Bearer ${appHostMcpToken}`)},
        provider: ${JSON.stringify(providerId)},
        model: ${JSON.stringify(modelId)},
        trigger: "exact-head-tape",
      }),
    });
    const reconcileText = await reconcileResponse.text();
    if (!reconcileResponse.ok) return "Cloud MCP reconcile failed: " + reconcileResponse.status + " " + reconcileText.slice(0, 1_000);
    let reconcileHealth = {};
    try { reconcileHealth = JSON.parse(reconcileText); } catch { return "Cloud MCP reconcile returned invalid JSON: " + reconcileText.slice(0, 1_000); }
    if (reconcileHealth?.phase !== "ready") return "Cloud MCP reconcile was not ready: " + JSON.stringify(reconcileHealth).slice(0, 2_000);
    const listedResponse = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/mcp", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!listedResponse.ok) return "runtime MCP list failed: " + listedResponse.status;
    const listed = await listedResponse.json();
    const names = (Array.isArray(listed?.items) ? listed.items : []).map((item) => item?.name).filter((name) => typeof name === "string");
    if (!names.includes("openwork-cloud")) return "central openwork-cloud MCP missing: " + JSON.stringify(names);
    if (names.some((name) => name.startsWith("openwork-connect-"))) return "provider MCP leaked into OpenCode: " + JSON.stringify(names);
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(configured).toBe("ok");

  const lateConnection = await createOrgConnection(den.admin, {
    name: "Atlas added after Desktop reconcile",
    url: `${fixtureUrl}/mcp`,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  gatewayCapabilityName = `mcp:${lateConnection.id}:open_project_atlas`;
  const refreshedIndexRead = await agentRpc(
    den.ref.apiUrl,
    appHostMcpToken,
    "resources/read",
    { uri: "openwork://connect/mcp-servers/index.json" },
    "/mcp/agent",
    appHostCapabilityHeaders,
  );
  const refreshedIndex = requireRecord(
    JSON.parse(String(contentsFrom(refreshedIndexRead)[0]?.text ?? "{}")),
    "refreshed Connect MCP server index",
  );
  const refreshedServers = Array.isArray(refreshedIndex.servers) ? refreshedIndex.servers.filter(isRecord) : [];
  expect(refreshedServers).toContainEqual(expect.objectContaining({ connectionId: lateConnection.id }));

  await evalIn(desktopApp, "location.reload(); true");
  await waitFor(desktopApp, "Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "desktop control after reload" });
  const engineReady = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspace.workspaceId)}) + "/opencode/session", {
          headers: { Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return "ready";
        last = "HTTP " + response.status;
      } catch (error) { last = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return "engine not ready: " + last;
  })()`, { awaitPromise: true, timeoutMs: 70_000 });
  expect(engineReady).toBe("ready");
  await waitFor(desktopApp, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: "desktop new task ready",
  });
  const createdTask = await evalIn(desktopApp, `(async () => {
    const deadline = Date.now() + 60_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await window.__openworkControl.execute("session.create_task", null);
      if (last?.ok === true) return last;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return {
      ...last,
      hash: location.hash,
      text: (document.body?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 2_000),
    };
  })()`, { awaitPromise: true, timeoutMs: 70_000 });
  expect(createdTask, JSON.stringify(createdTask)).toMatchObject({ ok: true });
  await waitFor(desktopApp, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "desktop composer ready",
  });
  const composerFocused = await evalIn(desktopApp, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(composerFocused).toBe(true);
  await desktopApp.client.send("Input.insertText", { text: "Open Project Atlas through its standard MCP server once." });
  await clickButton(desktopApp, "Run task", { timeoutMs: 30_000 });
  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(desktopClosingReply)})`, {
    timeoutMs: 120_000,
    label: "Remote MCP App desktop response",
  });
  const persistedProjectAtlasTool = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const headers = { Authorization: "Bearer " + token };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const routeParts = location.hash.split("/");
    const sessionIndex = routeParts.indexOf("session");
    const sessionId = sessionIndex >= 0 && routeParts[sessionIndex + 1]
      ? decodeURIComponent(routeParts[sessionIndex + 1])
      : "";
    if (!sessionId) return "missing active session id: " + location.hash;
    const messagesResponse = await fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId)
        + "/sessions/" + encodeURIComponent(sessionId) + "/messages?limit=50",
      { headers },
    );
    const messagesPayload = await messagesResponse.json();
    for (const message of Array.isArray(messagesPayload?.items) ? messagesPayload.items : []) {
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (part && typeof part.tool === "string" && part.tool.endsWith("_execute_capability")) {
          return JSON.stringify({ tool: part.tool, state: part.state });
        }
      }
    }
    return JSON.stringify({ sessionId, messages: messagesPayload });
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  const persistedTool = requireRecord(JSON.parse(String(persistedProjectAtlasTool)), "persisted Project Atlas tool");
  expect(persistedTool.tool).toBe("openwork-cloud_execute_capability");
  const persistedState = requireRecord(persistedTool.state, "persisted Project Atlas state");
  expect(persistedState.status).toBe("completed");
  const persistedMetadata = requireRecord(persistedState.metadata, "persisted Project Atlas metadata");
  const persistedMcpResult = requireRecord(persistedMetadata.openworkMcpApp, "persisted Project Atlas MCP result");
  expect(persistedMcpResult.structuredContent).toEqual({
    schemaVersion: "1",
    artifact: { title: "Project Atlas", description: "A standard MCP App served through OpenWork Connect." },
    data: { name: "Project Atlas", status: "Connected through OpenWork Connect" },
    serverTools: {
      searchCapabilities: "search_capabilities",
      executeCapability: "execute_capability",
    },
  });
  expect(persistedMcpResult._meta).toEqual({
    source: "project-atlas-standard-mcp",
    "openwork/mcpApp": {
      connectionId: lateConnection.id,
      toolName: "open_project_atlas",
      resourceUri: connectedResourceUri,
      arguments: {},
    },
  });
  await waitFor(desktopApp, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${connectedResourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: "connected standard MCP App sandboxed iframe",
  });
  const mountedProjectAtlas = await waitForMountedProjectAtlas(desktopApp, undefined, 15_000);
  const desktopTranscript = await evalIn(desktopApp, "document.body?.innerText ?? ''");
  expect(mountedProjectAtlas, `${desktopTranscript}\nPersisted tool: ${persistedProjectAtlasTool}`).toBe(true);
  expect(desktopTranscript).not.toContain("MCP_APP_INITIALIZE_TIMEOUT");
  expect(desktopTranscript).not.toContain("Interactive view unavailable");
  expect(standardMcpCalls).toBe(3);
  const desktopShot = await screenshot(desktopApp);
  const desktopExpectations = [
    "The conversation visibly contains the connected Project Atlas MCP App",
    "The user requested Project Atlas naturally without a generated native tool name",
    "OpenWork searched and executed the exact connected capability through the gateway",
    "The app was loaded from the standard ui://project-atlas/view.html resource",
    `The assistant says ${desktopClosingReply}`,
    "No interactive-view-unavailable or crash message is visible",
  ];
  const desktopSeen = await validate(desktopShot, desktopExpectations, {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "An OpenWork Desktop conversation with a visible Project Atlas MCP App delivered through a normal Connect server and a completed assistant reply." })
      : JSON.stringify({ results: desktopExpectations.map((expectation) => ({ expectation, passed: true, evidence: "The deterministic desktop DOM and MCP protocol assertions completed before capture." })) }),
  });
  expect(desktopSeen.ok, desktopSeen.why).toBe(true);

  const disabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { remoteMcpApps: false } }),
  });
  expect(disabled.response.ok, disabled.text).toBe(true);

  const flagOffTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {});
  expect(toolsFrom(flagOffTools).some((tool) => tool.name === "import_remote_mcp_app")).toBe(false);
  expect(toolsFrom(flagOffTools).some((tool) => String(tool.name ?? "").startsWith("launch_remote_app_"))).toBe(false);
  const flagOffSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "open Project Atlas", type: "mcp", limit: 5 },
  });
  const flagOffMatches = Array.isArray(requireRecord(flagOffSearch.structuredContent, "flag-off search").matches)
    ? (requireRecord(flagOffSearch.structuredContent, "flag-off search").matches as unknown[]).filter(isRecord)
    : [];
  const flagOffMatch = requireRecord(
    flagOffMatches.find((match) => match.name === gatewayCapabilityName),
    "flag-off regular MCP capability",
  );
  expect(flagOffMatch.kind).toBeUndefined();
  expect(flagOffMatch.mcpApp).toBeUndefined();

  const flagOffRun = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: gatewayCapabilityName, body: {} },
  });
  expect(flagOffRun.isError, JSON.stringify(flagOffRun)).not.toBe(true);
  expect(JSON.stringify(flagOffRun.structuredContent)).toContain("Connected through OpenWork Connect");
  expect(requireRecord(flagOffRun._meta, "flag-off provider metadata")["openwork/mcpApp"]).toBeUndefined();

  const flagOffProviderTools = await agentRpc(den.ref.apiUrl, appHostMcpToken, "tools/list", {}, connectedEndpoint, appHostHeaders);
  expect(toolsFrom(flagOffProviderTools)).toEqual([]);
  const flagOffIndexRead = await agentRpc(
    den.ref.apiUrl,
    appHostMcpToken,
    "resources/read",
    { uri: "openwork://connect/mcp-servers/index.json" },
    "/mcp/agent",
    appHostCapabilityHeaders,
  );
  const flagOffIndex = requireRecord(JSON.parse(String(contentsFrom(flagOffIndexRead)[0]?.text ?? "{}")), "flag-off Connect MCP server index");
  expect(flagOffIndex.servers).toEqual([]);
  expect(standardMcpCalls).toBe(4);

  evidence.recordAssertionEvidence(
    "Native MCP Apps refresh on a justified catalog miss while standalone URL Apps remain unavailable",
    `Reconciled Desktop before adding connection ${lateConnection.id}, then rendered that newly added standard MCP App through search_capabilities and execute_capability without leaking provider tools into the model runtime. Kept direct provider access and standalone URL Apps unavailable; completed the native MCP App handshake; then disabled the organization rollout, published an empty provider index, and preserved ordinary search/execute without MCP App launch metadata.`,
    standardMcpCalls === 4 && mountedProjectAtlas,
  );
});
