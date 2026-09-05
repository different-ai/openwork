import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clickButton, coworker, evalIn, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";
import { buildStandardAppHtml } from "../worlds/coworker.ts";

/**
 * Continue with OpenWork, end to end, without a real account: a deterministic
 * Den stands in for app.openworklabs.com and issues one handoff grant; the
 * organization grants one OpenAI-compatible provider whose model answers with
 * a fixed sentence. The product path under test is the real one — the same
 * handoff exchange, the embedded server's own provider sync, the engine's
 * provider list, and a native discussion turn — only the two remote services
 * are mocked.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker signs in with an OpenWork account, browses what OpenWork Connect brings it level by level, and runs a discussion turn on an organization model"
  : "Open Coworker OpenWork account journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const GRANT = "eval-handoff-grant-0001";
const SESSION_TOKEN = "eval-session-token-0001";
const ORG_ID = "org_eval_0001";
const ORG_NAME = "Eval Organization";
const PROVIDER_RECORD_ID = "lpr_eval_org";
const PROVIDER_KEY_ENV = "EVAL_ORG_API_KEY";
const PROVIDER_API_KEY = "eval-org-provider-key-0001";
const MODEL_ID = "eval-org-model";
const MODEL_NAME = "Eval Org Model";
const REPLY = "ACCOUNT MODEL READY";
const MCP_TOKEN = "eval-connect-gateway-token-0001";
const APP_HOST_TOKEN = "eval-connect-app-host-token-0001";
const CONNECTION_ID = "conn_eval_skills";
const CONNECTION_PATH = `/mcp/connections/${CONNECTION_ID}`;
const CONNECT_INDEX_URI = "openwork://connect/mcp-servers/index.json";
const SKILL_APP_TOOL = "skill_studio";
const SKILL_APP_RESOURCE = "ui://openwork-connect/skill-studio";
const SKILL_INDEX_URI = "skill://index.json";
const NOTION_CONNECTION_ID = "conn_eval_notion";
const RELEASE_PLUGIN_ID = "plg_eval_release";
const RELEASE_SKILL_ID = "cob_eval_release";

/**
 * A deterministic stand-in for the OpenWork Connect gateway (`/mcp/agent`):
 * the two capability tools every OpenWork client relies on, one built-in
 * skill behind them, and one standard MCP App so the coworker's Apps & tools
 * surface has something real to render.
 */
const skillAppHtml = await buildStandardAppHtml({
  reactSource: `export default function SkillStudio({ data }) {
    return <main><p className="eyebrow">SKILL STUDIO</p><h2>{data.title}</h2><p>{data.status}</p></main>
  }`,
  cssSource: "body{margin:0;padding:18px;color:#f7f8fa;background:#0c1018;font-family:ui-sans-serif,system-ui,sans-serif}main{border:1px solid #283142;border-radius:14px;padding:18px;background:#111722}.eyebrow{margin:0 0 8px;color:#8994a8;font-size:10px;letter-spacing:.16em}h2{margin:0 0 7px;font-size:18px}p{margin:0;color:#a8b1c1;font-size:13px}",
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" }, status: { type: "string" } },
    required: ["title", "status"],
  },
  title: "Skill studio",
  description: "Deterministic OpenWork Connect App fixture.",
});

type GatewayCall = { endpoint: "gateway" | "connection"; method: string; tool: string; authorization: string };

function gatewayResponse(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "openwork-connect-eval", version: "1.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "search_capabilities",
            description: "Search the organization's connected capabilities.",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            annotations: { readOnlyHint: true },
          },
          {
            name: "execute_capability",
            description: "Execute one capability by its exact name.",
            inputSchema: { type: "object", properties: { name: { type: "string" }, body: {} }, required: ["name"] },
          },
        ],
      },
    };
  }
  if (message.method === "resources/read" && params.uri === SKILL_INDEX_URI) {
    // The skills the member can use: one built in, one from a marketplace plugin.
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          uri: SKILL_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [
              { name: "create-skill", type: "skill-md", title: "Create Skill", description: "Create a new OpenWork Cloud skill.", url: "skill://create-skill/SKILL.md", capability: "skill:create-skill" },
              { name: "release", type: "skill-md", title: "Release", description: "Versioning, tagging, and release verification.", marketplaceName: "Engineering Marketplace", pluginName: "Release", url: "skill://release/SKILL.md", capability: `plugin:${RELEASE_PLUGIN_ID}:${RELEASE_SKILL_ID}` },
            ],
          }),
        }],
      },
    };
  }
  if (message.method === "resources/read" && params.uri === CONNECT_INDEX_URI) {
    // The organization's connections, as the gateway advertises them to app hosts.
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          uri: CONNECT_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "openwork.connect/mcp-servers/1",
            servers: [{
              connectionId: CONNECTION_ID,
              name: "Skill studio",
              description: "Skills shared with your team.",
              url: `${gatewayOrigin()}${CONNECTION_PATH}`,
            }],
          }),
        }],
      },
    };
  }
  if (message.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    if (name === "search_capabilities") {
      // Whatever the keywords, the same organization: a built-in skill, a marketplace plugin whose
      // service an admin still has to set up, and a connection the member has not signed in to.
      const matches = [
        { name: "skill:create-skill", kind: "skill", summary: "Create Skill: Create a new OpenWork Cloud skill.", method: "SKILL", path: "skill:create-skill", score: 3, pathParams: [], queryParams: [], hasBody: false },
        {
          name: `plugin:${RELEASE_PLUGIN_ID}:${RELEASE_SKILL_ID}`,
          kind: "skill",
          summary: "[Engineering Marketplace / Release] Release: Versioning, tagging, and release verification.",
          method: "PLUGIN",
          path: "Engineering Marketplace/Release",
          score: 2,
          pathParams: [],
          queryParams: [],
          hasBody: false,
          plugin: "Release",
          marketplace: "Engineering Marketplace",
          status: "needs_admin_setup",
          hint: "Release needs an org admin to configure its required MCP connection before it can run in OpenWork Cloud.",
          mcpRequirements: [{
            configObjectId: RELEASE_SKILL_ID,
            pluginId: RELEASE_PLUGIN_ID,
            pluginName: "Release",
            serverName: "github",
            name: "GitHub",
            state: "needs_admin_setup",
            action: { type: "setup_connection", label: "Set up GitHub", surface: "openwork_organization_connections", retry: "search_capabilities" },
          }],
        },
        {
          name: `mcp:${NOTION_CONNECTION_ID}:*`,
          kind: "connection_status",
          summary: "[Notion] Not connected for this member yet.",
          method: "MCP",
          path: "https://mcp.notion.example/mcp",
          score: 1,
          pathParams: [],
          queryParams: [],
          hasBody: false,
          status: "needs_connection",
          hint: "Execute this exact capability name once.",
          connectionStatus: {
            version: 1,
            kind: "connection_action",
            source: "openwork-cloud",
            connectionId: NOTION_CONNECTION_ID,
            connectionName: "Notion",
            authType: "oauth",
            credentialMode: "per_member",
            state: "needs_connection",
            actor: "member",
            action: { type: "connect", label: "Connect Notion", surface: "openwork_your_connections", retry: "search_capabilities" },
            message: "Notion is not connected for you yet.",
          },
        },
      ];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ matches }) }],
          structuredContent: { matches },
        },
      };
    }
    if (name === "execute_capability") {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "---\nname: create-skill\n---\nFollow these steps to create a skill." }] },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${name}` } };
  }
  if (message.method === "resources/read") {
    return { jsonrpc: "2.0", id, error: { code: -32002, message: `Unknown resource ${String(params.uri)}` } };
  }
  if (message.method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result: {} };
}

/** One organization connection behind the gateway: a standard MCP server with a single App. */
function connectionResponse(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "eval-skill-studio", version: "1.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: SKILL_APP_TOOL,
          title: "Skill studio",
          description: "Browse the skills your team shares.",
          inputSchema: { type: "object", properties: { topic: { type: "string", description: "What to find in shared skills" } }, required: ["topic"], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { ui: { resourceUri: SKILL_APP_RESOURCE } },
        }],
      },
    };
  }
  if (message.method === "tools/call" && params.name === SKILL_APP_TOOL) {
    if (!isRecord(params.arguments) || params.arguments.topic !== "shared skills") {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "A topic is required." }] } };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Skill studio: 3 shared skills" }],
        structuredContent: {
          schemaVersion: "1",
          artifact: { title: "Skill studio", description: "Skills shared with your team." },
          data: { title: "Skill studio", status: "3 shared skills" },
        },
      },
    };
  }
  if (message.method === "resources/read" && params.uri === SKILL_APP_RESOURCE) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          uri: SKILL_APP_RESOURCE,
          mimeType: "text/html;profile=mcp-app",
          blob: Buffer.from(skillAppHtml, "utf8").toString("base64"),
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
        }],
      },
    };
  }
  if (message.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported ${String(message.method)}` } };
}

let gatewayBaseUrl = "";
function gatewayOrigin(): string {
  return gatewayBaseUrl;
}

type Recorded = { method: string; path: string; authorization: string; org: string };

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

/** The hosted Den API answers browser origins with CORS; the renderer's exchange call needs the same here. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  response.end(JSON.stringify(payload));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

/** Text of the last user message in an OpenAI chat completion request, for the reply router. */
function lastUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return "";
  const user = [...body.messages].reverse().find((message) => isRecord(message) && message.role === "user");
  if (!isRecord(user)) return "";
  const content = user.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function clickButtonContaining(app: Awaited<ReturnType<typeof coworker>>, text: string): Promise<void> {
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(text)}) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`, { timeoutMs: 120_000, label: `button containing ${json(text)}` });
}

async function clickTestId(app: Awaited<ReturnType<typeof coworker>>, testId: string): Promise<void> {
  await waitFor(app, `(() => {
    const element = document.querySelector(${json(`[data-testid="${testId}"]`)});
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `click ${testId}` });
}

/** Walk the panel back to the root of its view, then to Activity. */
async function backToActivity(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement) || panel.dataset.collapsed === "true") return false;
    if (panel.dataset.view === "overview") return true;
    const back = document.querySelector('[data-testid="panel-back"]') ?? document.querySelector('button[aria-label="Back to activity"]');
    if (back instanceof HTMLElement) back.click();
    return false;
  })()`, { timeoutMs: 30_000, label: "back to the Activity sidebar" });
}

/** The Apps & tools root is the first level of Coworker settings. */
const APPS_TOOLS_ROUTE = "settings/apps-tools";

/**
 * Bring the right panel to the Apps & tools root from whatever state it is in: folded, on another
 * view (Escape folds it), on the Coworker settings rows (their first row opens it), or deeper inside.
 */
async function openAppsAndTools(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const route = document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "";
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings") {
      // The view remembers its last level for the session; the journeys start each visit at the root.
      if (route === ${json(APPS_TOOLS_ROUTE)}) return true;
      if (panel.dataset.depth === "0") document.querySelector('[data-testid="settings-row-apps-tools"]')?.click();
      else document.querySelector('[data-testid="panel-back"]')?.click();
      return false;
    }
    if (panel.dataset.collapsed === "true") {
      document.querySelector('[data-testid="context-rail-settings"]')?.click();
      return false;
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  })()`, { timeoutMs: 60_000, label: "Apps & tools root" });
}

/** Jump to one level of the trail by its depth: a visible crumb, or one folded into the … menu. */
async function clickCrumb(app: Awaited<ReturnType<typeof coworker>>, depth: number): Promise<void> {
  await waitFor(app, `(() => {
    const crumb = document.querySelector(${json(`[data-testid="panel-breadcrumbs"] [data-testid="panel-crumb"][data-depth="${depth}"]`)});
    if (crumb instanceof HTMLElement) {
      crumb.click();
      return true;
    }
    const open = document.querySelector(${json(`[role="menu"][aria-label="Levels above"] [data-testid="panel-crumb"][data-depth="${depth}"]`)});
    if (open instanceof HTMLElement) {
      open.click();
      return true;
    }
    document.querySelector('[data-testid="panel-crumb-more"]')?.click();
    return false;
  })()`, { timeoutMs: 30_000, label: `crumb at depth ${depth}` });
}

/** Open the right panel on its Activity view (it starts folded and closes when the coworker changes). */
async function openDetails(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "overview") return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-overview"]')?.click();
    else (document.querySelector('[data-testid="panel-back"]') ?? document.querySelector('button[aria-label="Back to activity"]'))?.click();
    return false;
  })()`, { timeoutMs: 60_000, label: "Activity view" });
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  let assignedTemplates: Array<Record<string, unknown>> = [];
  let coworkerTeamsEnabled = false;

  // --- Mock organization model: an OpenAI-compatible endpoint that answers deterministically.
  const completionAuthorizations: string[] = [];
  let connectedInstructionsSeen = false;
  let gatewaySearchUnavailable = false;
  const model = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      respondJson(response, 200, { object: "list", data: [{ id: MODEL_ID, object: "model" }] });
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void readBody(request).then((raw) => {
        completionAuthorizations.push(request.headers.authorization ?? "");
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (isRecord(body) && Array.isArray(body.messages)) {
          connectedInstructionsSeen ||= body.messages.some((message: unknown) => isRecord(message)
            && message.role === "system"
            && typeof message.content === "string"
            && message.content.includes("## Working with connected apps")
            && message.content.includes("search_capabilities")
            && message.content.includes("An app being connected is not consent to every action."));
        }
        const prompt = lastUserText(body);
        const reply = prompt.includes("SECOND") ? `SECOND ${REPLY}` : REPLY;
        const chunks = [
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    respondJson(response, 404, { error: { message: `mock model: no route for ${request.method} ${url}` } });
  });
  const modelBaseUrl = `${await listen(model)}/v1`;

  // --- Mock Den: the handoff exchange plus the member-scoped provider routes the embedded server reads,
  // the Connect token mint, and the Connect gateway.
  const denRequests: Recorded[] = [];
  const gatewayCalls: GatewayCall[] = [];
  let mintedTokens = 0;
  let denBaseUrl = "";
  const providerRecord = {
    id: PROVIDER_RECORD_ID,
    providerId: "eval-org",
    name: "Eval Org Provider",
    source: "custom",
    updatedAt: "2026-09-01T00:00:00.000Z",
    providerConfig: {
      npm: "@ai-sdk/openai-compatible",
      env: [PROVIDER_KEY_ENV],
      options: { baseURL: modelBaseUrl },
    },
    models: [{ id: MODEL_ID, name: MODEL_NAME, config: { tool_call: false, reasoning: false } }],
  };
  let membershipResponse: "active" | "unpaid" | "setup" | "unavailable" | "admin" = "active";
  const den = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://den.local");
    // Self-hosted Den is addressed through its /api/den proxy path.
    const path = url.pathname.replace(/^\/api\/den(?=\/|$)/, "");
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const org = String(request.headers["x-openwork-legacy-org-id"] ?? request.headers["x-openwork-org-id"] ?? "");
    denRequests.push({ method: request.method ?? "", path, authorization, org });

    if (request.method === "POST" && path === "/v1/auth/desktop-handoff/exchange") {
      void readBody(request).then((raw) => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (!isRecord(body) || body.grant !== GRANT) {
          respondJson(response, 400, { error: "invalid_grant", message: "The sign-in code is missing, expired, or already used." });
          return;
        }
        respondJson(response, 200, {
          token: SESSION_TOKEN,
          user: { name: "Eval Member", email: "member@eval.example" },
          organization: { id: ORG_ID, slug: "eval", name: ORG_NAME },
          connectEnabled: false,
        });
      });
      return;
    }
    // --- The Connect gateway (model-facing, minted MCP token) and the connection behind it (app-host token).
    const isGateway = path === "/mcp/agent";
    const isConnection = path === CONNECTION_PATH;
    if (isGateway || isConnection) {
      if (request.method === "GET") {
        response.writeHead(405, CORS_HEADERS);
        response.end();
        return;
      }
      const allowed = isGateway
        ? [`Bearer ${MCP_TOKEN}`, `Bearer ${APP_HOST_TOKEN}`]
        : [`Bearer ${APP_HOST_TOKEN}`];
      if (!allowed.includes(authorization)) {
        respondJson(response, 401, { error: "unauthorized", message: "Gateway token missing or invalid." });
        return;
      }
      void readBody(request).then((raw) => {
        let parsed: unknown = null;
        try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { parsed = null; }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies: Record<string, unknown>[] = [];
        for (const candidate of messages) {
          if (!isRecord(candidate)) continue;
          const params = isRecord(candidate.params) ? candidate.params : {};
          gatewayCalls.push({
            endpoint: isGateway ? "gateway" : "connection",
            method: typeof candidate.method === "string" ? candidate.method : "",
            tool: typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : "",
            authorization,
          });
          const reply = isGateway && gatewaySearchUnavailable && candidate.method === "tools/call" && params.name === "search_capabilities"
            ? { jsonrpc: "2.0", id: candidate.id, result: { isError: true, content: [{ type: "text", text: "Catalog temporarily unavailable" }] } }
            : isGateway ? gatewayResponse(candidate) : connectionResponse(candidate);
          if (reply) replies.push(reply);
        }
        if (replies.length === 0) {
          response.writeHead(202, CORS_HEADERS);
          response.end();
          return;
        }
        respondJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
      });
      return;
    }
    if (authorization !== `Bearer ${SESSION_TOKEN}`) {
      respondJson(response, 401, { error: "unauthorized", message: "Missing or invalid session token." });
      return;
    }
    if (request.method === "POST" && path === "/v1/mcp/token") {
      mintedTokens += 1;
      respondJson(response, 200, {
        token: MCP_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        organizationId: ORG_ID,
        resource: `${denBaseUrl}/mcp`,
        scopes: ["mcp:read", "mcp:write"],
        appHostToken: APP_HOST_TOKEN,
        appHostExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      return;
    }
    if (request.method === "GET" && path === "/v1/me/orgs") {
      respondJson(response, 200, { orgs: [{ id: ORG_ID, name: ORG_NAME }], activeOrgId: ORG_ID });
      return;
    }
    if (request.method === "GET" && path === "/v1/inference") {
      if (org !== ORG_ID) { respondJson(response, 403, { error: "wrong_organization" }); return; }
      if (membershipResponse === "unavailable" || membershipResponse === "admin") { respondJson(response, membershipResponse === "admin" ? 403 : 503, { error: "unavailable" }); return; }
      respondJson(response, 200, { inference: {
        subscribed: membershipResponse !== "unpaid", enabled: membershipResponse === "active", upstreamProviderConfigured: membershipResponse === "active",
        buckets: [
          { windowType: "five_hour", windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 60_000).toISOString(), limitAmount: 100, usedAmount: 25 },
          { windowType: "weekly", windowStartAt: "2020-01-01T00:00:00Z", windowEndAt: "2020-01-08T00:00:00Z", limitAmount: 100, usedAmount: 0 },
        ],
      } });
      return;
    }
    if (request.method === "GET" && path === "/v1/me/coworkers") {
      respondJson(response, 200, { enabled: coworkerTeamsEnabled, items: assignedTemplates, nextCursor: null });
      return;
    }
    if (request.method === "GET" && path === "/v1/llm-providers") {
      respondJson(response, 200, { llmProviders: [providerRecord] });
      return;
    }
    if (request.method === "GET" && path === `/v1/llm-providers/${PROVIDER_RECORD_ID}/connect`) {
      respondJson(response, 200, {
        llmProvider: { ...providerRecord, apiKey: PROVIDER_API_KEY, apiKeys: null, memberCredential: { state: "active" } },
      });
      return;
    }
    if (request.method === "GET" && path === "/v1/automations") {
      respondJson(response, 200, { items: [], nextCursor: null });
      return;
    }
    respondJson(response, 404, { error: "not_found", message: `mock Den: no route for ${request.method} ${path}` });
  });
  denBaseUrl = await listen(den);
  gatewayBaseUrl = denBaseUrl;

  await using app = await coworker({ name: "openwork-account", env: { COWORKER_DEN_BASE_URL: denBaseUrl } });

  // --- First run: choose the account path and complete the handoff by pasting the link Den would show.
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  await waitFor(app, `(() => {
    const choice = document.querySelector('[data-testid="onboarding-cloud-choice"]');
    if (!choice) return false;
    choice.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Continue with OpenWork choice" });
  await waitForText(app, "Continue with OpenWork", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="sign-in-gate"]'))`, { timeoutMs: 30_000, label: "sign-in gate" });
  const gateText = String(await evalIn(app, "document.body.innerText"));
  expect(gateText).toContain("Open OpenWork sign-in");
  expect(gateText.toLowerCase()).toContain("paste sign-in link");
  expect(gateText).toContain("same OpenWork account you use in OpenWork Desktop");
  expect(await evalIn(app, `document.querySelector('[data-testid="sign-in-gate"] input')?.placeholder ?? ""`)).toContain("opencoworker://den-auth");

  await fill(
    app,
    'input[placeholder^="opencoworker://den-auth"]',
    `opencoworker://den-auth?grant=${GRANT}&denBaseUrl=${encodeURIComponent(denBaseUrl)}`,
  );
  await clickButton(app, "Connect");

  // The exchange happened against the mock Den and the account moved on to the team steps; this
  // journey takes the blank Add screen instead of a proposed team.
  await waitFor(app, `(() => {
    const own = document.querySelector('[data-testid="onboarding-intents-own"]');
    if (!(own instanceof HTMLElement)) return false;
    own.click();
    return true;
  })()`, { timeoutMs: 120_000, label: "the team step's own-coworker link" });
  await waitForText(app, "Add a coworker", { timeoutMs: 120_000 });
  expect(denRequests.some((entry) => entry.method === "POST" && entry.path === "/v1/auth/desktop-handoff/exchange")).toBe(true);
  // The embedded server, not the renderer, read the organization's providers with the session it was handed
  // (sign-in awaits that sync before it moves on to coworker creation).
  const providerReads = denRequests.filter((entry) => entry.path === "/v1/llm-providers" || entry.path.endsWith("/connect"));
  expect(providerReads.length).toBeGreaterThanOrEqual(2);
  expect(providerReads.every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  const storedSession = await evalIn(app, `(() => {
    const raw = window.localStorage.getItem("coworker.den.session.v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { orgName: parsed.orgName, userEmail: parsed.userEmail, hasToken: typeof parsed.token === "string" && parsed.token.length > 0 };
  })()`);
  expect(storedSession).toEqual({ orgName: ORG_NAME, userEmail: "member@eval.example", hasToken: true });

  evidence.recordAssertionEvidence(
    "Continue with OpenWork completes the real desktop handoff and hands the account to the embedded server",
    `The pasted ${"opencoworker://den-auth"} link was exchanged at /v1/auth/desktop-handoff/exchange, the session persisted for ${ORG_NAME}, and the embedded server fetched the member's providers (${providerReads.length} authenticated reads) before any coworker existed.`,
    true,
  );

  // --- Create the first coworker (name and look only), then choose its AI model in Coworker settings,
  // where the organization model must be offered and labelled as OpenWork Cloud.
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 120_000, label: "Scout discussion view" });
  expect(await evalIn(app, `document.querySelector('[data-testid="composer-model-control"]') === null`)).toBe(true);
  // A person waits for the coworker to read Ready before asking anything of it; so does the journey.
  await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(status instanceof HTMLElement)) return false;
    return status.textContent?.trim() === "Ready";
  })()`, { timeoutMs: 240_000, label: "coworker AI ready" });
  // Coworker settings is reached from the strip's own icon; the Activity view carries no second control for it.
  await openDetails(app);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="coworker-settings-button"]'))`)).toBe(false);
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings" && panel.dataset.depth === "0") return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-settings"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  })()`, { timeoutMs: 30_000, label: "Coworker settings from the strip" });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="coworker-model-settings"] [data-testid="model-picker"] > button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open the AI model picker in Coworker settings" });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="model-provider-${PROVIDER_RECORD_ID}"]'))`, {
    timeoutMs: 180_000,
    label: "organization provider group in the model picker",
  });
  const pickerFacts = await evalIn(app, `(() => {
    const group = document.querySelector('[data-testid="model-provider-${PROVIDER_RECORD_ID}"]');
    return {
      groupText: group?.textContent ?? "",
      cloudTagInGroup: Boolean(group?.querySelector('[data-testid="model-source-cloud"]')),
      summary: document.querySelector('[data-testid="model-picker-summary"]')?.textContent ?? "",
    };
  })()`);
  expect(pickerFacts).toMatchObject({ cloudTagInGroup: true });
  if (!isRecord(pickerFacts) || typeof pickerFacts.groupText !== "string" || typeof pickerFacts.summary !== "string") {
    throw new Error("Model picker facts were unavailable.");
  }
  expect(pickerFacts.groupText).toContain("Eval Org Provider");
  expect(pickerFacts.groupText).toContain(MODEL_NAME);
  expect(pickerFacts.summary).toContain("come from your OpenWork account");
  expect(pickerFacts.summary).toContain(ORG_NAME);

  await clickButtonContaining(app, MODEL_NAME);
  await waitForText(app, `Eval Org Provider · ${MODEL_ID} · OpenWork Cloud`, { timeoutMs: 30_000 });
  const scout = await waitFor(app, `window.__COWORKER__.invoke("coworkers.get", { slug: "scout" })
    .then((response) => (response.ok && response.result?.model === ${json(`${PROVIDER_RECORD_ID}/${MODEL_ID}`)} ? response.result : false))`, {
    awaitPromise: true,
    timeoutMs: 30_000,
    label: "organization model persisted on Scout",
  });
  expect(isRecord(scout) && scout.model).toBe(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);
  await backToActivity(app);

  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-empty"]')?.querySelectorAll("button").length`)).toBe(0);
  await clickButtonContaining(app, "Starting points");
  await waitFor(app, `(() => { const panel = document.querySelector('[aria-label="A useful first step"]'); if (!panel) return false; const rect = panel.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`, { timeoutMs: 5_000, label: "starting points remain within the window" });
  await clickButton(app, "Turn a goal into a plan");
  const starter = await evalIn(app, `document.querySelector('textarea[aria-label="Message Scout"]')?.value ?? ""`);
  expect(String(starter)).toContain("Ask what I want to achieve");
  expect(await evalIn(app, `document.querySelectorAll('[data-message-role="user"]').length`)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  evidence.recordAssertionEvidence("A new conversation offers a useful starting point as an editable draft", "The quiet empty canvas retained its avatar and had no action cards. Opening Starting points beside the composer and choosing Turn a goal into a plan filled the composer with a practical request. It sent no message and created no work until the person chose Send.", true);

  evidence.recordAssertionEvidence(
    "The organization's model reaches Coworker settings labelled by source, without a model step in creation",
    `Scout was created from a name alone; in Coworker settings the picker grouped ${MODEL_NAME} under Eval Org Provider with an OpenWork Cloud tag and a summary naming ${ORG_NAME}, and selecting it persisted ${PROVIDER_RECORD_ID}/${MODEL_ID} on Scout.`,
    true,
  );

  // --- OpenWork Connect reaches the coworker: one minted gateway token, the gateway registered in Scout's
  // workspace, and the Apps & tools root row reporting it in plain words.
  await openAppsAndTools(app);
  const rootRow = await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="apps-tools-row-connected"]');
    if (!(row instanceof HTMLElement)) return false;
    const text = row.innerText;
    if (!text.includes("Connected as") && !text.includes("Needs") && !text.includes("Unavailable")) return false;
    return text;
  })()`, { timeoutMs: 240_000, label: "OpenWork Connect settled for Scout" });
  expect(String(rootRow)).toContain(`Connected as ${ORG_NAME}`);
  await clickTestId(app, "apps-tools-row-connected");
  const connectCard = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="coworker-connect-card"]');
    if (!(card instanceof HTMLElement) || card.getAttribute("data-status") !== "connected") return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      text: card.innerText,
      status: document.querySelector('[data-testid="coworker-connect-status"]')?.textContent?.trim() ?? "",
      askEnabled: !(card.querySelector('[data-testid="coworker-connect-ask"]')?.disabled ?? true),
      createSkillEnabled: !(card.querySelector('[data-testid="coworker-connect-create-skill"]')?.disabled ?? true),
      detail: document.querySelector('[data-testid="coworker-connect-detail"]')?.textContent ?? "",
    };
  })()`, { timeoutMs: 240_000, label: "OpenWork Connect connected for Scout" });
  expect(connectCard).toMatchObject({ route: `${APPS_TOOLS_ROUTE}/connected`, status: `Connected as ${ORG_NAME}`, askEnabled: true, createSkillEnabled: true, detail: "" });
  if (!isRecord(connectCard) || typeof connectCard.text !== "string") throw new Error("Connect card facts were unavailable.");
  expect(connectCard.text).toContain(ORG_NAME);
  expect(connectCard.text).toContain("Start with a task");
  expect(connectCard.text).toContain("Just describe the result.");
  expect(connectCard.text).not.toContain("can use everything");
  expect(connectCard.text.toLowerCase()).not.toContain("mcp");
  expect(mintedTokens).toBeGreaterThanOrEqual(1);
  const gatewayToolLists = gatewayCalls.filter((call) => call.endpoint === "gateway" && call.method === "tools/list");
  expect(gatewayToolLists.length).toBeGreaterThanOrEqual(1);
  expect(gatewayToolLists.every((call) => call.authorization === `Bearer ${MCP_TOKEN}`)).toBe(true);
  expect(gatewayCalls.some((call) => call.endpoint === "gateway" && call.method === "resources/read" && call.tool === CONNECT_INDEX_URI && call.authorization === `Bearer ${APP_HOST_TOKEN}`)).toBe(true);
  const connectHealth = await evalIn(app, `(async () => {
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    const scout = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/openwork-cloud/health", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const health = await response.json();
    return { status: response.status, usable: health.usable, present: health.tools?.present ?? [], url: health.desired?.config?.url ?? null };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(connectHealth).toMatchObject({ status: 200, usable: true, url: `${denBaseUrl}/mcp/agent` });
  if (!isRecord(connectHealth) || !Array.isArray(connectHealth.present)) throw new Error("Connect health was unavailable.");
  expect(connectHealth.present).toEqual(expect.arrayContaining(["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"]));
  evidence.recordAssertionEvidence(
    "Signing in wires OpenWork Connect into the coworker's workspace",
    `After sign-in the app minted ${mintedTokens} gateway token(s) and registered the gateway at ${denBaseUrl}/mcp/agent in Scout's workspace; the embedded server reported it usable with both capability tools present, every gateway call carried the minted bearer token, the Apps & tools root row read Connected as ${ORG_NAME}, and the Connected screen led with Start with a task and Create a skill enabled and no MCP vocabulary.`,
    true,
  );

  const ownToolsEndpoint = await evalIn(app, `(async () => {
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    const scout = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/config", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const config = await response.json();
    return { status: response.status, url: config.opencode?.mcp?.coworker?.url };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(ownToolsEndpoint) || typeof ownToolsEndpoint.url !== "string") throw new Error("Coworker tools endpoint was unavailable.");
  expect(ownToolsEndpoint.status).toBe(200);
  expect(new URL(ownToolsEndpoint.url).hostname).toBe("127.0.0.1");
  for (const authorization of ["Basic unknown", "Bearer " + " ".repeat(8_000) + "invalid token", "Bearer unknown"] ) {
    const rejected = await fetch(ownToolsEndpoint.url, { method: "POST", headers: { Authorization: authorization }, body: "{}", signal: AbortSignal.timeout(5_000) });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "unauthorized" });
  }
  const ownTools = await evalIn(app, `(async () => {
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    const scout = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/coworker/tools", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const listed = await response.json();
    return { status: response.status, count: listed.tools?.length ?? 0 };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(ownTools).toMatchObject({ status: 200 });
  if (!isRecord(ownTools) || typeof ownTools.count !== "number") throw new Error("Coworker tool discovery was unavailable.");
  expect(ownTools.count).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The packaged coworker tool server rejects malformed bearer credentials and remains usable with its registered credentials",
    "Unknown, wrong-scheme, and long whitespace-bearing credentials returned 401 without tool access; authenticated tool discovery still returned the coworker's tools afterward.", true,
  );

  // --- The Connected screen's four groups, read through the gateway's skill index and its search.
  const connectedRows = await waitFor(app, `(() => {
    const rows = ["connected-apps", "skills", "plugins", "connections"].map((id) => document.querySelector('[data-testid="apps-tools-row-' + id + '"]'));
    if (!rows.every((row) => row instanceof HTMLElement)) return false;
    const texts = rows.map((row) => row.innerText);
    if (texts.some((text) => text.includes("Reading"))) return false;
    return texts;
  })()`, { timeoutMs: 120_000, label: "Connected screen rows settled" });
  if (!Array.isArray(connectedRows)) throw new Error("Connected rows were unavailable.");
  const [appsRowText, skillsRowText, pluginsRowText, connectionsRowText] = connectedRows.map(String);
  expect(appsRowText).toContain("Apps");
  expect(appsRowText).toContain("1");
  expect(skillsRowText).toContain("Skills");
  expect(skillsRowText).toContain("2");
  expect(pluginsRowText).toContain("Plugins & marketplaces");
  expect(pluginsRowText).toContain("1");
  expect(pluginsRowText).toContain("needs attention");
  expect(connectionsRowText).toContain("Connections");
  expect(connectionsRowText).toContain("2");
  expect(connectionsRowText).toContain("1 needs attention");
  const searchQueries = gatewayCalls.filter((call) => call.endpoint === "gateway" && call.method === "tools/call" && call.tool === "search_capabilities");
  expect(searchQueries.length).toBeGreaterThanOrEqual(2);
  expect(searchQueries.length).toBeLessThanOrEqual(4);
  expect(gatewayCalls.some((call) => call.endpoint === "gateway" && call.method === "resources/read" && call.tool === SKILL_INDEX_URI)).toBe(true);

  // Browsing an unavailable keyword offers help as a draft, never an implicit execution.
  const callsBeforeDraft = completionAuthorizations.length;
  await fill(app, '[data-testid="apps-tools-search"]', "prepare a project handover");
  await clickTestId(app, "apps-tools-ask-search");
  expect(String(await evalIn(app, `document.querySelector('textarea[aria-label="Message Scout"]')?.value ?? ""`))).toBe("Help me with this using my connected apps: prepare a project handover\n\nFind what's available and suggest the next step before taking action.");
  expect(completionAuthorizations.length).toBe(callsBeforeDraft);
  expect(await evalIn(app, `document.querySelectorAll('[data-message-role="user"]').length`)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-connected");

  await clickTestId(app, "apps-tools-row-connections");
  const connectionRows = await waitFor(app, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="apps-tools-connection"]')];
    if (rows.length !== 2) return false;
    return rows.map((row) => row.innerText.replace(/\\s+/g, " ").trim());
  })()`, { timeoutMs: 60_000, label: "connections as rows" });
  expect(connectionRows).toEqual([expect.stringMatching(/^Notion Needs sign-in/), expect.stringMatching(/^Skill studio Connected 1/)]);
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="apps-tools-connection"]')].find((candidate) => (candidate.textContent ?? "").includes("Notion"));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open Notion" });
  const notion = await waitFor(app, `(() => {
    const detail = document.querySelector('[data-testid="coworker-connection-detail"]');
    if (!(detail instanceof HTMLElement)) return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      status: document.querySelector('[data-testid="apps-tools-detail-status"]')?.textContent?.trim(),
      action: document.querySelector('[data-testid="apps-tools-human-action"]')?.textContent ?? "",
      text: detail.innerText,
      askEnabled: !(detail.querySelector('[data-testid="apps-tools-ask"]')?.disabled ?? true),
    };
  })()`, { timeoutMs: 30_000, label: "Notion connection detail" });
  expect(notion).toMatchObject({ route: `${APPS_TOOLS_ROUTE}/connected/connections/connection:${NOTION_CONNECTION_ID}`, status: "Needs sign-in", askEnabled: false });
  if (!isRecord(notion) || typeof notion.action !== "string" || typeof notion.text !== "string") throw new Error("Notion detail facts were unavailable.");
  expect(notion.action).toContain("Connect Notion on your Connections page in OpenWork.");
  expect(notion.text).toContain("Notion is not connected for you yet.");
  expect(notion.text.toLowerCase()).not.toContain("needs_connection");
  await clickCrumb(app, 1);
  await clickTestId(app, "apps-tools-row-connected");
  await clickTestId(app, "apps-tools-row-plugins");
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="apps-tools-plugin"]')].find((candidate) => (candidate.textContent ?? "").includes("Release"));
    if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("Needs setup by an admin")) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 60_000, label: "the Release plugin reads Needs setup by an admin" });
  const release = await waitFor(app, `(() => {
    const detail = document.querySelector('[data-testid="coworker-plugin-detail"]');
    const servers = document.querySelector('[data-testid="apps-tools-plugin-servers"]');
    if (!(detail instanceof HTMLElement) || !(servers instanceof HTMLElement)) return false;
    return { text: detail.innerText, servers: servers.innerText, skills: [...detail.querySelectorAll('[data-testid="apps-tools-skill"]')].map((row) => row.textContent) };
  })()`, { timeoutMs: 30_000, label: "Release plugin detail" });
  if (!isRecord(release) || typeof release.text !== "string" || typeof release.servers !== "string") throw new Error("Release detail facts were unavailable.");
  expect(release.text).toContain("Engineering Marketplace");
  expect(release.servers).toContain("GitHub");
  expect(release.servers).toContain("Needs setup by an admin");
  expect(release.servers).toContain("Ask an organization admin to set up GitHub on the organization's Connections dashboard in OpenWork.");
  expect(release.skills).toEqual([expect.stringContaining("Release")]);
  expect(release.text.toLowerCase()).not.toContain("needs_admin_setup");
  await clickCrumb(app, 1);
  await clickTestId(app, "apps-tools-row-connected");
  await clickTestId(app, "apps-tools-row-skills");
  const skillRows = await waitFor(app, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="apps-tools-skill"]')];
    if (rows.length !== 2) return false;
    return rows.map((row) => row.innerText.replace(/\\s+/g, " ").trim());
  })()`, { timeoutMs: 60_000, label: "skills as rows" });
  expect(skillRows).toEqual([expect.stringMatching(/^Create Skill Built in/), expect.stringMatching(/^Release Release · Engineering Marketplace/)]);
  evidence.recordAssertionEvidence(
    "The Connected screen lists Apps, Skills, Plugins & marketplaces, and Connections in plain words with the human step that unblocks each",
    "Read through the gateway's skill index and at most four keyword searches: Skills listed Create Skill (built in) and Release (Engineering Marketplace); Plugins listed Release as Needs setup by an admin, its detail naming GitHub and asking an organization admin to set it up on the organization's Connections dashboard; Connections listed Notion (Needs sign-in, with the step Connect Notion on your Connections page in OpenWork) and Skill studio (Connected) — never a status code.",
    true,
  );

  // --- A gateway App renders through the same standard MCP App path, and skill creation is one click from a prompt.
  const appCatalog = await evalIn(app, `(async () => {
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    const scout = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" });
    const headers = { Authorization: "Bearer " + runtime.result.ownerToken };
    const base = runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId);
    const [apps, inventory] = await Promise.all([
      fetch(base + "/mcp-apps/list", { headers }).then((response) => response.json()),
      fetch(base + "/mcp", { headers }).then((response) => response.json()),
    ]);
    return { apps, inventoryNames: (inventory.items ?? []).map((item) => [item.name, item.source]) };
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(appCatalog, `App catalog: ${JSON.stringify(appCatalog)}`).toMatchObject({
    apps: { servers: expect.arrayContaining([expect.objectContaining({ displayName: "Skill studio", connectionId: CONNECTION_ID, reachable: true })]) },
  });
  async function openSkillStudio() {
    await openAppsAndTools(app);
    await clickTestId(app, "apps-tools-row-connected");
    await clickTestId(app, "apps-tools-row-connected-apps");
    await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="coworker-mcp-app"]')].find((candidate) => (candidate.textContent ?? "").includes("Skill studio"));
    if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("OpenWork Connect")) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 120_000, label: "Skill studio App from OpenWork Connect" });
  }
  await openSkillStudio();
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-mcp-app-detail"] textarea') === null`)).toBe(true);
  expect(await evalIn(app, `document.querySelector('[data-testid="apps-tools-open-app"]') === null`)).toBe(true);
  const appCallsBeforeDraft = gatewayCalls.filter((call) => call.endpoint === "connection" && call.method === "tools/call").length;
  await clickTestId(app, "apps-tools-ask");
  expect(String(await evalIn(app, `document.querySelector('textarea[aria-label="Message Scout"]')?.value ?? ""`))).toBe("Help me use Skill studio to: ");
  expect(gatewayCalls.filter((call) => call.endpoint === "connection" && call.method === "tools/call").length).toBe(appCallsBeforeDraft);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await openSkillStudio();
  await clickTestId(app, "apps-tools-advanced-input");
  await fill(app, '[data-testid="coworker-mcp-app-detail"] textarea', '{"topic":"shared skills"}');
  await clickTestId(app, "apps-tools-open-app");
  await waitFor(app, `document.querySelector(${json(`[data-mcp-app-resource="${SKILL_APP_RESOURCE}"]`)})?.getAttribute("data-mcp-app-ready") === "true"`, {
    timeoutMs: 120_000,
    label: "Skill studio App mounted",
  });
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "tools/call" && call.tool === SKILL_APP_TOOL && call.authorization === `Bearer ${APP_HOST_TOKEN}`)).toBe(true);
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "resources/read" && call.tool === SKILL_APP_RESOURCE)).toBe(true);
  await clickTestId(app, "panel-back");
  await clickTestId(app, "panel-back");
  await waitFor(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === ${json(`${APPS_TOOLS_ROUTE}/connected`)}`, { timeoutMs: 30_000, label: "back on the Connected screen" });
  await clickTestId(app, "coworker-connect-create-skill");
  const skillDraft = String(await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("repeatable task") ? composer.value : false;
  })()`, { timeoutMs: 30_000, label: "create-skill message prefilled" }));
  expect(skillDraft).toBe("Help me turn a repeatable task into a skill for my team. The task is: ");
  expect(skillDraft).not.toMatch(/search_capabilities|execute_capability|MCP|conn_eval/);
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].length`)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  evidence.recordAssertionEvidence(
    "Gateway Apps render and skill creation starts from the Connected screen",
    `The Skill studio App, published by an organization connection behind the Connect gateway, was listed under Connected › Apps with its OpenWork Connect source line, opened through the connection's own tools/call and resources/read, and mounted in the sandbox; two Backs returned to the Connected screen, where Create a skill prefilled Scout's discussion with a plain-language request about the repeatable task, without sending it.`,
    true,
  );

  // A failed discovery stays recoverable and cannot be cached as an empty account.
  await openAppsAndTools(app);
  gatewaySearchUnavailable = true;
  await waitFor(app, `(() => { const button = document.querySelector('button[aria-label="Refresh"]'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`, { timeoutMs: 30_000, label: "refresh connected apps" });
  await waitForText(app, "Some connected apps and skills couldn't be loaded", { timeoutMs: 60_000 });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="coworker-capabilities"]')?.textContent ?? ""`))).not.toContain("Your organization has not connected any services");
  gatewaySearchUnavailable = false;
  await new Promise((resolve) => setTimeout(resolve, 15_100));
  await evalIn(app, `window.dispatchEvent(new Event("online")); true`);
  await waitFor(app, `!document.querySelector('[data-testid="apps-tools-connect-problem"]') && document.querySelector('button[aria-label="Refresh"]')?.disabled === false`, { timeoutMs: 60_000, label: "catalog refreshed after the outage" });
  await clickTestId(app, "apps-tools-row-connected");
  await clickTestId(app, "apps-tools-row-connections");
  await waitForText(app, "Notion", { timeoutMs: 30_000 });
  await backToActivity(app);
  evidence.recordAssertionEvidence("Connected work starts with a task and discovery errors recover without configuration", "Task and app actions filled ordinary editable discussion drafts without a model request or app execution. An app requiring input showed no JSON editor by default; its advanced path still opened with validated input. A catalog failure showed a retry message and going back online refreshed the connection list without a manual configuration step.", true);

  // --- A real discussion turn on that model, with the credential delivered by the server, not the UI.
  const prompt = `Reply with exactly ${REPLY}.`;
  await fill(app, 'textarea[aria-label="Message Scout"]', prompt);
  await clickButton(app, "Send");
  const reply = await waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(REPLY)}));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 300_000, label: "assistant reply from the organization model" });
  expect(String(reply)).toContain(REPLY);
  const replyModel = await waitFor(app, `document.querySelector('[data-testid="coworker-reply-model"]')?.textContent ?? false`, {
    timeoutMs: 30_000,
    label: "answering model attribution",
  });
  expect(String(replyModel)).toContain(MODEL_ID);
  expect(completionAuthorizations.length).toBeGreaterThanOrEqual(1);
  expect(completionAuthorizations.every((value) => value === `Bearer ${PROVIDER_API_KEY}`)).toBe(true);
  expect(connectedInstructionsSeen).toBe(true);
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 60_000,
    label: "coworker settles to Ready after a matched reply",
  });

  evidence.recordAssertionEvidence(
    "A discussion turn runs on the organization model with the account's credential and is attributed honestly",
    `Scout answered "${REPLY}" through ${PROVIDER_RECORD_ID}/${MODEL_ID}; the mock provider saw ${completionAuthorizations.length} completion request(s), each authorized with the credential Den granted, and the reply carried the model attribution before the thread reported Ready.`,
    true,
  );

  // --- Reload: unsent work, account, providers, and selection persist.
  await fill(app, 'textarea[aria-label="Message Scout"]', "Keep this unfinished request for my return.");
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 120_000, label: "Scout discussion view" });
  await waitForText(app, REPLY, { timeoutMs: 60_000 });
  expect(await evalIn(app, `document.querySelector('textarea[aria-label="Message Scout"]')?.value`)).toBe("Keep this unfinished request for my return.");
  expect(String(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].map((element) => element.textContent).join("\\n")`))).not.toContain("Keep this unfinished request for my return.");
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await clickButtonContaining(app, ORG_NAME);
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "Account");
  await waitFor(app, `document.querySelector('[data-testid="account-status"]')?.textContent === "OpenWork connected"`, {
    timeoutMs: 30_000,
    label: "connected account status",
  });
  const accountText = String(await evalIn(app, `document.querySelector('[data-testid="account-card"]')?.innerText ?? ""`));
  expect(accountText).toContain(ORG_NAME);
  expect(accountText).toContain("member@eval.example");
  expect(accountText).not.toContain(SESSION_TOKEN);
  await clickButton(app, "AI models");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="cloud-providers"]'))`, { timeoutMs: 60_000, label: "OpenWork Cloud provider group" });
  // The group appears while the account's models are still being read; wait for the provider itself.
  await waitForText(app, "Eval Org Provider", { timeoutMs: 60_000 });
  const modelsText = String(await evalIn(app, "document.body.innerText"));
  expect(modelsText).toContain("Eval Org Provider");
  expect(modelsText).toContain(PROVIDER_RECORD_ID);
  expect(modelsText).not.toContain(PROVIDER_API_KEY);

  await waitForText(app, "Membership active", { timeoutMs: 30_000 });
  const membershipText = String(await evalIn(app, `document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""`));
  expect(membershipText).toContain("75% left");
  expect(membershipText).toContain("Waiting for refreshed usage");
  expect(membershipText).toContain("Manage membership");
  expect(membershipText).not.toMatch(/free credits|launch offer|limited offer|guaranteed faster/);
  expect(denRequests.filter((entry) => entry.path === "/v1/inference").every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  membershipResponse = "unavailable";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Membership status is unavailable", { timeoutMs: 30_000 });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""`))).not.toContain("No active Models membership");
  membershipResponse = "admin";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Your workspace admin manages the membership", { timeoutMs: 30_000 });
  membershipResponse = "unpaid";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "No active Models membership", { timeoutMs: 30_000 });
  const unpaidText = String(await evalIn(app, `document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""`));
  expect(unpaidText).toContain("View models & pricing");
  expect(unpaidText).not.toMatch(/Manage membership|75% left|Membership active/);
  membershipResponse = "setup";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Membership active · setup needs attention", { timeoutMs: 30_000 });
  const setupText = String(await evalIn(app, `document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""`));
  expect(setupText).toContain("Finish Models setup");
  expect(setupText).not.toMatch(/No active Models membership|View models & pricing/);
  membershipResponse = "active";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Manage membership", { timeoutMs: 30_000 });
  expect(denRequests.filter((entry) => entry.path === "/v1/inference").every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  expect(denRequests.some((entry) => entry.method === "POST" && /billing|checkout/.test(entry.path))).toBe(false);
  evidence.recordAssertionEvidence(
    "Models membership shows authenticated workspace usage; errors and member permissions never masquerade as an unpaid subscription",
    "The account-scoped read showed 75% remaining and a management action, refused to present an expired bucket as fresh usage, and explained 503 and 403 without an unpaid claim. Confirmed unpaid accounts saw pricing; paid accounts needing setup saw Finish Models setup. No checkout was created and no promotion was advertised.", true,
  );

  evidence.recordAssertionEvidence(
    "Account and provider state survive reload and are explained without exposing secrets",
    "After reload the discussion and reply were still present, Account showed OpenWork connected with the organization and member, and AI models listed the organization provider under OpenWork Cloud. Neither the session token nor the provider key appeared on screen.",
    true,
  );

  // --- Sign out: the server sweeps the account's providers, and the saved model becomes visibly unavailable.
  await clickButton(app, "Account");
  await clickButton(app, "Sign out");
  await waitFor(app, `document.querySelector('[data-testid="account-status"]')?.textContent === "Local mode"`, {
    timeoutMs: 60_000,
    label: "signed-out account status",
  });
  expect(await evalIn(app, `window.localStorage.getItem("coworker.den.session.v1")`)).toBeNull();
  await clickButton(app, "AI models");
  // The sweep reloads the engine asynchronously; re-read the catalog until the account group is gone.
  await waitFor(app, `document.querySelector('[data-testid="models-membership"]')?.getAttribute("data-state") === "signed-out"`, { timeoutMs: 30_000, label: "membership clears on sign-out" });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""`))).not.toMatch(/Membership active|75% left/);
  const sweepDeadline = Date.now() + 180_000;
  for (;;) {
    const swept = await evalIn(app, `(() => {
      const body = document.body.innerText;
      return !document.querySelector('[data-testid="cloud-providers"]')
        && !body.includes("Reading OpenWork models")
        && (Boolean(document.querySelector('[data-testid="local-providers"]'))
          || body.includes("No connected provider models are available"));
    })()`);
    if (swept === true) break;
    if (Date.now() > sweepDeadline) throw new Error("Organization providers were still listed 180s after sign-out.");
    await clickButton(app, "Refresh", { timeoutMs: 30_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await clickButtonContaining(app, "Back to coworkers");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 60_000, label: "Scout discussion view" });
  const gatewayAfterSignOut = await evalIn(app, `(async () => {
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    const scout = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/openwork-cloud/health", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const health = await response.json().catch(() => null);
    return { status: response.status, present: health?.desired?.present ?? null };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(isRecord(gatewayAfterSignOut) && (gatewayAfterSignOut.status === 404 || gatewayAfterSignOut.present === false)).toBe(true);
  await openAppsAndTools(app);
  await waitFor(app, `(document.querySelector('[data-testid="apps-tools-row-connected"]')?.textContent ?? "").includes("Not connected")`, {
    timeoutMs: 30_000,
    label: "the Connected with OpenWork row reads Not connected",
  });
  await clickTestId(app, "apps-tools-row-connected");
  const signedOutCard = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="coworker-connect-card"]');
    if (!(card instanceof HTMLElement) || card.getAttribute("data-status") !== "signed-out") return false;
    return { pitch: card.getAttribute("data-pitch"), text: card.innerText, fillsPanel: card.getBoundingClientRect().height >= 400 };
  })()`, { timeoutMs: 30_000, label: "Connect card back to its signed-out pitch" });
  // Signed out for the first time this session, the explanation is the first step again.
  expect(signedOutCard).toMatchObject({ pitch: "full", fillsPanel: true });
  if (!isRecord(signedOutCard) || typeof signedOutCard.text !== "string") throw new Error("Signed-out card facts were unavailable.");
  expect(signedOutCard.text).toContain("Continue with OpenWork");
  await clickButton(app, "Skip");
  await waitFor(app, `document.querySelector('[data-testid="coworker-connect-card"]')?.getAttribute("data-pitch") === "compact"`, { timeoutMs: 30_000, label: "short Connect form after Skip" });
  await backToActivity(app);
  await fill(app, 'textarea[aria-label="Message Scout"]', "Reply with exactly SIGNED OUT.");
  await clickButton(app, "Send");
  const failureText = String(await waitFor(app, `document.querySelector('[data-testid="coworker-turn-failed"]')?.textContent ?? false`, {
    timeoutMs: 120_000,
    label: "visible failure for the now-unavailable organization model",
  }));
  expect(failureText).toContain("Scout's AI model is not available.");
  expect(failureText).toContain(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);
  expect(failureText).toContain("no OpenWork account is signed in");
  expect(failureText).toContain("Continue with OpenWork");
  expect(failureText).toContain("Choose AI model");

  evidence.recordAssertionEvidence(
    "Signing out removes the organization's providers and turns the saved model into an actionable failure",
    `After Sign out the settings showed Local mode with no OpenWork Cloud group, the Apps & tools root row read Not connected with the Connect explanation as the Connected screen's first step again (Skip left the short card), and the next discussion turn failed visibly with a plain headline, naming ${PROVIDER_RECORD_ID}/${MODEL_ID} in the detail, explaining that no account is signed in, with Continue with OpenWork and Choose AI model actions.`,
    true,
  );

  // A new teammate receives a prepared team through the same account handoff.
  await app.stop();
  const starts = completionAuthorizations.length;
  const startingTemplate = { kind: "coworker", schemaVersion: 1, description: "Ready for the marketing team", role: "Marketing", mission: "Help plan campaigns", instructions: "Ask for the audience before drafting.", provisioning: "automatic" };
  coworkerTeamsEnabled = true;
  assignedTemplates = [
    { id: "campaign", versionId: "one", assigned: true, template: { ...startingTemplate, name: "Campaign partner" } },
    { id: "research", versionId: "one", assigned: true, template: { ...startingTemplate, name: "Research partner" } },
    { id: "catalog", versionId: "one", assigned: false, template: { ...startingTemplate, name: "Catalog only" } },
    { id: "optional", versionId: "one", assigned: true, template: { ...startingTemplate, name: "Optional partner", provisioning: "optional" } },
  ];
  await using teammateApp = await coworker({ name: "assigned-team", env: { COWORKER_DEN_BASE_URL: denBaseUrl } });
  await clickTestId(teammateApp, "onboarding-cloud-choice");
  await waitForText(teammateApp, "Continue with OpenWork", { timeoutMs: 120_000 });
  await fill(teammateApp, 'input[placeholder^="opencoworker://den-auth"]', `opencoworker://den-auth?grant=${GRANT}&denBaseUrl=${encodeURIComponent(denBaseUrl)}`);
  await clickButton(teammateApp, "Connect");
  await waitFor(teammateApp, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && document.body.innerText.includes("Campaign partner")`, { timeoutMs: 180_000, label: "assigned coworkers ready after first sign-in" });
  const readTeam = () => evalIn(teammateApp, `(async () => (await window.__COWORKER__.invoke("coworkers.list")).result.map(({slug, name, model, automations}) => ({slug, name, model, automations})))()`, { awaitPromise: true });
  expect(await readTeam()).toEqual([
    expect.objectContaining({ name: "Campaign partner", automations: [] }),
    expect.objectContaining({ name: "Research partner", automations: [] }),
  ]);
  const initialSoul = await evalIn(teammateApp, `(async () => (await window.__COWORKER__.invoke("coworkers.files.read", {slug:"campaign-partner", path:"soul.md"})).result.content)()`, { awaitPromise: true });
  expect(initialSoul).toContain(startingTemplate.instructions);
  expect(completionAuthorizations.length).toBe(starts);
  expect(denRequests.filter((entry) => entry.path === "/v1/me/coworkers").every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  evidence.recordAssertionEvidence("An assigned team is ready on first account sign-in", "A fresh Open Coworker profile signed in through the real handoff and displayed Campaign partner and Research partner without manual creation. The reusable instructions were installed; optional and catalog-only coworkers were not created. No scheduled work was imported, and provisioning made no completion requests.", true);

  await evalIn(teammateApp, `(async () => window.__COWORKER__.invoke("coworkers.files.write", {slug:"campaign-partner", path:"memory/working.md", content:"My campaign work stays here."}))()`, { awaitPromise: true });
  assignedTemplates[0] = { ...assignedTemplates[0], versionId: "two", template: { ...startingTemplate, name: "Campaign partner", instructions: "New instructions for future copies." } };
  await evalIn(teammateApp, "location.reload(); true");
  await waitFor(teammateApp, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]'))`, { timeoutMs: 120_000, label: "assigned team after reload" });
  await clickButtonContaining(teammateApp, ORG_NAME);
  await clickButton(teammateApp, "Account");
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitForText(teammateApp, "Template updated · your working copy is preserved", { timeoutMs: 120_000 });
  expect(await readTeam()).toHaveLength(2);
  const preserved = await evalIn(teammateApp, `(async () => {
    const read = async (path) => (await window.__COWORKER__.invoke("coworkers.files.read", {slug:"campaign-partner", path})).result.content;
    return { memory: await read("memory/working.md"), soul: await read("soul.md") };
  })()`, { awaitPromise: true });
  expect(preserved).toMatchObject({ memory: "My campaign work stays here.", soul: expect.stringContaining(startingTemplate.instructions) });
  await waitFor(teammateApp, `(() => { const button = document.querySelector('[data-template-id="optional"] button'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`, { timeoutMs: 30_000, label: "add an optional assigned coworker" });
  await waitFor(teammateApp, `document.querySelector('[data-template-id="optional"]')?.textContent.includes("Already added")`, { timeoutMs: 120_000, label: "optional coworker added" });
  expect(await readTeam()).toHaveLength(3);
  await evalIn(teammateApp, `(async () => window.__COWORKER__.invoke("coworkers.delete", {slug:"research-partner"}))()`, { awaitPromise: true });
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitFor(teammateApp, `!document.querySelector('[data-testid="assigned-coworkers"] button')?.disabled`, { timeoutMs: 120_000, label: "assignment refresh after retirement" });
  expect(await readTeam()).toHaveLength(2);
  expect(completionAuthorizations.length).toBe(starts);
  coworkerTeamsEnabled = false;
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitFor(teammateApp, `document.querySelector('[data-testid="assigned-coworkers"]')?.textContent.includes("Coworker templates") && !document.querySelector('[data-template-id="optional"]')`, { timeoutMs: 30_000, label: "disabled team controls hidden" });
  expect(await readTeam()).toHaveLength(2);
  expect(await evalIn(teammateApp, `document.body.innerText.includes("Refresh assigned coworkers")`)).toBe(false);
  coworkerTeamsEnabled = true;
  await clickButton(teammateApp, "General");
  await clickButton(teammateApp, "Account");
  await waitForText(teammateApp, "Refresh assigned coworkers", { timeoutMs: 30_000 });
  expect(await readTeam()).toHaveLength(2);
  evidence.recordAssertionEvidence("Turning prepared teams off hides their controls while keeping personal coworkers", "The disabled catalog deliberately still contained templates; the client failed closed on enabled=false, hid team controls, and preserved both personal coworkers. Returning to Account after re-enabling discovered the flag and restored the controls without duplicates.", true);
  evidence.recordAssertionEvidence("Refreshes preserve personal work, optional choices, and retirement", "After a version update and reload, the team still had two coworkers and Account explained the preserved working copy. Original starting instructions and edited working memory were unchanged. Explicitly adding an optional coworker created one copy; retiring another and refreshing did not recreate it. No background completion requests were made.", true);
});
