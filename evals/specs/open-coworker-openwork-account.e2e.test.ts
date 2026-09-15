import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { browserScript, clickButton, coworker, evalIn, eventually, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";
import { buildStandardAppHtml, clickCoworkerControl, isolatedAccountCoworker, observeCoworkerVoice, typeCoworkerSpace, voiceMp3, type CoworkerTestBridge } from "../worlds/coworker.ts";

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
  ? "Open Coworker authenticates account-scoped models and apps, preserves membership boundaries, and provisions assigned teammates"
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
const VOICE_SENTENCES = ["The next step is ready.", "Review the draft before sending."];
const VOICE_REPLY = VOICE_SENTENCES.join(" ");
const VOICE_REASONING = "Private reasoning must never be spoken.";
const TRANSCRIPT = "Add the recording to my draft.";
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
const skillAppSource = {
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
};

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
function connectionResponse(message: Record<string, unknown>, skillAppHtml: string): Record<string, unknown> | null {
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
  return evalIn(app, browserScript((command, payload) => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return bridge.invoke(command, payload);
  }, [command, payload]), { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function clickButtonContaining(app: Awaited<ReturnType<typeof coworker>>, text: string): Promise<void> {
  await waitFor(app, browserScript((text) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(text) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  }, [text]), { timeoutMs: 120_000, label: `button containing ${JSON.stringify(text)}` });
}

async function clickTestId(app: Awaited<ReturnType<typeof coworker>>, testId: string): Promise<void> {
  await waitFor(app, browserScript((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element.click();
    return true;
  }, [`[data-testid="${testId}"]`]), { timeoutMs: 30_000, label: `click ${testId}` });
}

/** Walk the panel back to the root of its view, then to Activity. */
async function backToActivity(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, () => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement) || panel.dataset.collapsed === "true") return false;
    if (panel.dataset.view === "overview") return true;
    const back = document.querySelector('[data-testid="panel-back"]') ?? document.querySelector('button[aria-label="Back to activity"]');
    if (back instanceof HTMLElement) back.click();
    return false;
  }, { timeoutMs: 30_000, label: "back to the Activity sidebar" });
}

/** The Apps & tools root is the first level of Coworker settings. */
const APPS_TOOLS_ROUTE = "settings/apps-tools";

/**
 * Bring the right panel to the Apps & tools root from whatever state it is in: folded, on another
 * view (Escape folds it), on the Coworker settings rows (their first row opens it), or deeper inside.
 */
async function openAppsAndTools(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, browserScript((appsToolsRoute) => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const route = document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "";
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings") {
      // The view remembers its last level for the session; the journeys start each visit at the root.
      if (route === appsToolsRoute) return true;
      if (panel.dataset.depth === "0") document.querySelector<HTMLElement>('[data-testid="settings-row-apps-tools"]')?.click();
      else document.querySelector<HTMLElement>('[data-testid="panel-back"]')?.click();
      return false;
    }
    if (panel.dataset.collapsed === "true") {
      document.querySelector<HTMLElement>('[data-testid="context-rail-settings"]')?.click();
      return false;
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }, [APPS_TOOLS_ROUTE]), { timeoutMs: 60_000, label: "Apps & tools root" });
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence, skip }) => {
  // These loopback witnesses cannot serve a remote desktop, and a dev-head fallback is not package proof.
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"], placement: "local", env: ["OPENWORK_EVAL_ELECTRON_BINARY"] });
  const skillAppHtml = await buildStandardAppHtml(skillAppSource);
  let capturePrerequisite: string | null = null;
  let assignedTemplates: Array<Record<string, unknown>> = [];
  let coworkerTeamsEnabled = false;

  // --- Mock organization model: an OpenAI-compatible endpoint that answers deterministically.
  const completionAuthorizations: string[] = [];
  let connectedInstructionsSeen = false;
  let gatewaySearchUnavailable = false;
  const voiceCompletion: { finish?: () => void } = {};
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
            && message.content.includes("Discovery alone authorizes no execution")
            && message.content.includes("person's authorization and app approvals; a connection grants neither."));
        }
        const prompt = lastUserText(body);
        const voiceTurn = prompt.includes("voice reply check");
        const reply = voiceTurn ? VOICE_REPLY : prompt.includes("SECOND") ? `SECOND ${REPLY}` : REPLY;
        const chunks = [
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (voiceTurn) response.write(`data: ${JSON.stringify({ ...chunks[0], choices: [{ index: 0, delta: { reasoning_content: VOICE_REASONING }, finish_reason: null }] })}\n\n`);
        for (const chunk of chunks.slice(0, -1)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const finish = () => {
          response.write(`data: ${JSON.stringify(chunks.at(-1))}\n\n`);
          response.end("data: [DONE]\n\n");
        };
        if (voiceTurn) voiceCompletion.finish = finish;
        else finish();
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
  const transcriptions: unknown[] = [];
  const speeches: Array<{ body: unknown; cancelled: boolean }> = [];
  let holdSpeech = true;
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
            : isGateway ? gatewayResponse(candidate) : connectionResponse(candidate, skillAppHtml);
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
    if (path === "/v1/voice" || path.startsWith("/v1/voice/")) {
      if (org !== ORG_ID) { respondJson(response, 403, { error: "wrong_organization" }); return; }
      if (request.method === "GET" && path === "/v1/voice") {
        respondJson(response, 200, { access: membershipResponse === "active" ? "ready" : "membership_required" });
        return;
      }
      if (request.method === "POST" && membershipResponse !== "active") {
        respondJson(response, 403, { error: "voice_membership_required" });
        return;
      }
      if (request.method === "POST" && request.headers["content-type"] !== "application/json") {
        respondJson(response, 400, { error: "voice_invalid_request" });
        return;
      }
      if (request.method === "POST" && path === "/v1/voice/transcriptions") {
        void readBody(request).then((raw) => {
          transcriptions.push(JSON.parse(raw));
          respondJson(response, 200, { text: TRANSCRIPT });
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/voice/speech") {
        void readBody(request).then((raw) => {
          const speech: { body: unknown; cancelled: boolean } = { body: JSON.parse(raw), cancelled: false };
          speeches.push(speech);
          response.on("close", () => { speech.cancelled = !response.writableEnded; });
          // Hold the real native transport open so Stop audio must abort it, not merely hide UI.
          response.writeHead(200, { "content-type": "audio/mpeg", ...CORS_HEADERS });
          response.flushHeaders();
          if (!holdSpeech) response.end(voiceMp3);
        });
        return;
      }
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
    if (request.method === "GET" && path === "/v1/me/desktop-config") {
      if (org !== ORG_ID) { respondJson(response, 403, { error: "wrong_organization" }); return; }
      // An organization with no additional restrictions; native media consent is independent.
      respondJson(response, 200, {});
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

  await using app = await isolatedAccountCoworker("openwork-account", denBaseUrl, true);
  await using capture = await observeCoworkerVoice(app);

  // --- First run: choose the account path and complete the handoff by pasting the link Den would show.
  await waitFor(app, () => (document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker"), {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  await waitFor(app, () => {
    const choice = document.querySelector<HTMLElement>('[data-testid="onboarding-cloud-choice"]');
    if (!choice) return false;
    choice.click();
    return true;
  }, { timeoutMs: 30_000, label: "Continue with OpenWork choice" });
  await waitForText(app, "Continue with OpenWork", { timeoutMs: 30_000 });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="sign-in-gate"]')), { timeoutMs: 30_000, label: "sign-in gate" });

  await fill(
    app,
    'input[placeholder^="opencoworker://den-auth"]',
    `opencoworker://den-auth?grant=${GRANT}&denBaseUrl=${encodeURIComponent(denBaseUrl)}`,
  );
  await clickButton(app, "Connect");

  // The exchange happened against the mock Den and the account moved on to the team steps; this
  // journey takes the blank Add screen instead of a proposed team.
  await waitFor(app, () => {
    const own = document.querySelector('[data-testid="onboarding-intents-own"]');
    if (!(own instanceof HTMLElement)) return false;
    own.click();
    return true;
  }, { timeoutMs: 120_000, label: "the team step's own-coworker link" });
  await waitForText(app, "Add a coworker", { timeoutMs: 120_000 });
  expect(denRequests.some((entry) => entry.method === "POST" && entry.path === "/v1/auth/desktop-handoff/exchange")).toBe(true);
  // The embedded server, not the renderer, read the organization's providers with the session it was handed
  // (sign-in awaits that sync before it moves on to coworker creation).
  const providerReads = denRequests.filter((entry) => entry.path === "/v1/llm-providers" || entry.path.endsWith("/connect"));
  expect(providerReads.length).toBeGreaterThanOrEqual(2);
  expect(providerReads.every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  const storedSession = await evalIn(app, () => {
    const raw = window.localStorage.getItem("coworker.den.session.v1");
    if (!raw) return null;
    const parsed: { orgName?: string; userEmail?: string; token?: string } = JSON.parse(raw);
    return { orgName: parsed.orgName, userEmail: parsed.userEmail, hasToken: typeof parsed.token === "string" && parsed.token.length > 0 };
  });
  expect(storedSession).toEqual({ orgName: ORG_NAME, userEmail: "member@eval.example", hasToken: true });

  evidence.recordAssertionEvidence(
    "Continue with OpenWork completes the real desktop handoff and hands the account to the embedded server",
    `The pasted ${"opencoworker://den-auth"} link was exchanged at /v1/auth/desktop-handoff/exchange, the session persisted for ${ORG_NAME}, and the embedded server fetched the member's providers (${providerReads.length} authenticated reads) before any coworker existed.`,
    true,
  );

  // Choose the account's model in Coworker settings.
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout"), { timeoutMs: 120_000, label: "Scout discussion view" });
  // A person waits for the coworker to read Ready before asking anything of it; so does the journey.
  await waitFor(app, () => {
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(status instanceof HTMLElement)) return false;
    return status.textContent?.trim() === "Ready";
  }, { timeoutMs: 240_000, label: "coworker AI ready" });
  await waitFor(app, () => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings" && panel.dataset.depth === "0") return true;
    if (panel.dataset.collapsed === "true") document.querySelector<HTMLElement>('[data-testid="context-rail-settings"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }, { timeoutMs: 30_000, label: "Coworker settings from the strip" });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, () => {
    const button = document.querySelector('[data-testid="coworker-model-settings"] [data-testid="model-picker"] > button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, { timeoutMs: 30_000, label: "open the AI model picker in Coworker settings" });
  await waitFor(app, browserScript((selector) => Boolean(document.querySelector(selector)), [`[data-testid="model-provider-${PROVIDER_RECORD_ID}"]`]), {
    timeoutMs: 180_000,
    label: "organization provider group in the model picker",
  });
  await clickButtonContaining(app, MODEL_NAME);
  const scout = await waitFor(app, browserScript((model) => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return bridge.invoke("coworkers.get", { slug: "scout" })
      .then((response) => (response.ok && response.result?.model === model ? response.result : false));
  }, [`${PROVIDER_RECORD_ID}/${MODEL_ID}`]), {
    awaitPromise: true,
    timeoutMs: 30_000,
    label: "organization model persisted on Scout",
  });
  expect(isRecord(scout) && scout.model).toBe(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);
  await backToActivity(app);

  await clickButtonContaining(app, "Starting points");
  await clickButton(app, "Turn a goal into a plan");
  const starter = await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value ?? "");
  expect(String(starter)).toContain("Ask what I want to achieve");
  expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(0);
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "idle", { timeoutMs: 30_000, label: "welcome draft transferred into a voice-ready native discussion" });
  expect(denRequests.filter((entry) => entry.path === "/v1/voice")).toEqual(Array(2).fill({ method: "GET", path: "/v1/voice", authorization: `Bearer ${SESSION_TOKEN}`, org: ORG_ID }));
  expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(starter);
  expect(await evalIn(app, () => document.activeElement?.getAttribute("data-testid"))).toBe("voice-panel");
  await clickCoworkerControl(app, { role: "textbox", label: "Message Scout" });
  await typeCoworkerSpace(app);
  expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(`${starter} `);
  expect(await evalIn(app, () => document.activeElement?.getAttribute("aria-label"))).toBe("Message Scout");
  expect(await capture.read()).toMatchObject({ calls: 0, tracks: [], playback: [] });
  expect(completionAuthorizations).toEqual([]);
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  evidence.recordAssertionEvidence("First-use voice creates a discussion without losing the draft or stealing typing", "From the welcome composer, Voice transferred the starting-point draft into a native discussion, rechecked member access, and focused the voice panel. Clicking the draft and typing Space inserted a space without capturing audio or sending a completion.", true);
  evidence.recordAssertionEvidence("A starting point remains an editable draft", "Choosing Turn a goal into a plan filled the composer without adding a user message.", true);

  evidence.recordAssertionEvidence(
    "The organization's model can be selected for a coworker",
    `Selecting ${MODEL_NAME} in Coworker settings persisted ${PROVIDER_RECORD_ID}/${MODEL_ID} on Scout.`,
    true,
  );

  // --- OpenWork Connect reaches the coworker: one minted gateway token, the gateway registered in Scout's
  // workspace, and the Apps & tools root row reporting it in plain words.
  await openAppsAndTools(app);
  const rootRow = await waitFor(app, () => {
    const row = document.querySelector('[data-testid="apps-tools-row-connected"]');
    if (!(row instanceof HTMLElement)) return false;
    const text = row.innerText;
    if (!text.includes("Connected as")) return false;
    return text;
  }, { timeoutMs: 240_000, label: "OpenWork Connect settled for Scout" });
  expect(String(rootRow)).toContain(`Connected as ${ORG_NAME}`);
  await clickTestId(app, "apps-tools-row-connected");
  await waitFor(app, () => document.querySelector('[data-testid="coworker-connect-card"]')?.getAttribute("data-status") === "connected", { timeoutMs: 240_000, label: "OpenWork Connect connected for Scout" });
  expect(mintedTokens).toBeGreaterThanOrEqual(1);
  const gatewayToolLists = gatewayCalls.filter((call) => call.endpoint === "gateway" && call.method === "tools/list");
  expect(gatewayToolLists.length).toBeGreaterThanOrEqual(1);
  expect(gatewayToolLists.every((call) => call.authorization === `Bearer ${MCP_TOKEN}`)).toBe(true);
  expect(gatewayCalls.some((call) => call.endpoint === "gateway" && call.method === "resources/read" && call.tool === CONNECT_INDEX_URI && call.authorization === `Bearer ${APP_HOST_TOKEN}`)).toBe(true);
  const connectHealth = await evalIn(app, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    const runtime = await bridge.invoke("runtime.info");
    const scout = await bridge.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/openwork-cloud/health", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const health: { usable?: boolean; tools?: { present?: string[] }; desired?: { config?: { url?: string } } } = await response.json();
    return { status: response.status, usable: health.usable, present: health.tools?.present ?? [], url: health.desired?.config?.url ?? null };
  }, { awaitPromise: true, timeoutMs: 60_000 });
  expect(connectHealth).toMatchObject({ status: 200, usable: true, url: `${denBaseUrl}/mcp/agent` });
  if (!isRecord(connectHealth) || !Array.isArray(connectHealth.present)) throw new Error("Connect health was unavailable.");
  expect(connectHealth.present).toEqual(expect.arrayContaining(["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"]));
  evidence.recordAssertionEvidence(
    "Signing in wires OpenWork Connect into the coworker's workspace",
    `After sign-in the app minted ${mintedTokens} gateway token(s); Scout's registered gateway was usable with both capability tools. Tool discovery used the MCP token, the connection index used the App-host token, and Apps & tools reported Connected as ${ORG_NAME}.`,
    true,
  );

  const ownToolsEndpoint = await evalIn(app, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    const runtime = await bridge.invoke("runtime.info");
    const scout = await bridge.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/config", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const config: { opencode?: { mcp?: { coworker?: { url?: string } } } } = await response.json();
    return { status: response.status, url: config.opencode?.mcp?.coworker?.url };
  }, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(ownToolsEndpoint) || typeof ownToolsEndpoint.url !== "string") throw new Error("Coworker tools endpoint was unavailable.");
  expect(ownToolsEndpoint.status).toBe(200);
  expect(new URL(ownToolsEndpoint.url).hostname).toBe("127.0.0.1");
  for (const authorization of ["Basic unknown", "Bearer " + " ".repeat(8_000) + "invalid token", "Bearer unknown"] ) {
    const rejected = await fetch(ownToolsEndpoint.url, { method: "POST", headers: { Authorization: authorization }, body: "{}", signal: AbortSignal.timeout(5_000) });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "unauthorized" });
  }
  const ownTools = await evalIn(app, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    const runtime = await bridge.invoke("runtime.info");
    const scout = await bridge.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/coworker/tools", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const listed: { tools?: unknown[] } = await response.json();
    return { status: response.status, count: listed.tools?.length ?? 0 };
  }, { awaitPromise: true, timeoutMs: 30_000 });
  expect(ownTools).toMatchObject({ status: 200 });
  if (!isRecord(ownTools) || typeof ownTools.count !== "number") throw new Error("Coworker tool discovery was unavailable.");
  expect(ownTools.count).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The packaged coworker tool server rejects malformed bearer credentials and remains usable with its registered credentials",
    "Unknown, wrong-scheme, and long whitespace-bearing credentials returned 401 without tool access; authenticated tool discovery still returned the coworker's tools afterward.", true,
  );

  await waitFor(app, () => document.querySelector('[data-testid="apps-tools-row-connections"]')?.textContent?.includes("Reading") === false, { timeoutMs: 120_000, label: "connected discovery settled" });
  const searchQueries = gatewayCalls.filter((call) => call.endpoint === "gateway" && call.method === "tools/call" && call.tool === "search_capabilities");
  expect(searchQueries.length).toBeGreaterThanOrEqual(2);
  expect(searchQueries.length).toBeLessThanOrEqual(4);
  expect(gatewayCalls.some((call) => call.endpoint === "gateway" && call.method === "resources/read" && call.tool === SKILL_INDEX_URI)).toBe(true);

  // Browsing an unavailable keyword offers help as a draft, never an implicit execution.
  const callsBeforeDraft = completionAuthorizations.length;
  await fill(app, '[data-testid="apps-tools-search"]', "prepare a project handover");
  await clickTestId(app, "apps-tools-ask-search");
  expect(String(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value ?? ""))).toBe("Help me with this using my connected apps: prepare a project handover\n\nFind what's available and suggest the next step before taking action.");
  expect(completionAuthorizations.length).toBe(callsBeforeDraft);
  expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-connected");

  await clickTestId(app, "apps-tools-row-connections");
  await waitFor(app, () => {
    const row = [...document.querySelectorAll('[data-testid="apps-tools-connection"]')].find((candidate) => (candidate.textContent ?? "").includes("Notion"));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  }, { timeoutMs: 30_000, label: "open Notion" });
  const notion = await waitFor(app, () => {
    const detail = document.querySelector('[data-testid="coworker-connection-detail"]');
    if (!(detail instanceof HTMLElement)) return false;
    return {
      status: document.querySelector('[data-testid="apps-tools-detail-status"]')?.textContent?.trim(),
      action: document.querySelector('[data-testid="apps-tools-human-action"]')?.textContent ?? "",
      askEnabled: !(detail.querySelector<HTMLButtonElement>('[data-testid="apps-tools-ask"]')?.disabled ?? true),
    };
  }, { timeoutMs: 30_000, label: "Notion connection detail" });
  expect(notion).toMatchObject({ status: "Needs sign-in", askEnabled: false });
  if (!isRecord(notion) || typeof notion.action !== "string") throw new Error("Notion detail facts were unavailable.");
  expect(notion.action).toContain("Connect Notion on your Connections page in OpenWork.");
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-connected");
  await clickTestId(app, "apps-tools-row-plugins");
  await waitFor(app, () => {
    const row = [...document.querySelectorAll('[data-testid="apps-tools-plugin"]')].find((candidate) => (candidate.textContent ?? "").includes("Release"));
    if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("Needs setup by an admin")) return false;
    row.click();
    return true;
  }, { timeoutMs: 60_000, label: "the Release plugin reads Needs setup by an admin" });
  const release = await waitFor(app, () => {
    const detail = document.querySelector('[data-testid="coworker-plugin-detail"]');
    const servers = document.querySelector('[data-testid="apps-tools-plugin-servers"]');
    if (!(detail instanceof HTMLElement) || !(servers instanceof HTMLElement)) return false;
    return servers.innerText;
  }, { timeoutMs: 30_000, label: "Release plugin detail" });
  expect(String(release)).toContain("Needs setup by an admin");
  expect(String(release)).toContain("Ask an organization admin to set up GitHub on the organization's Connections dashboard in OpenWork.");
  evidence.recordAssertionEvidence(
    "Connection blockers distinguish the member's sign-in from administrator setup",
    "Discovery read the skill index and used two to four searches. Notion disabled Ask and directed the member to their Connections page; Release directed an organization admin to set up GitHub on the organization's Connections dashboard.",
    true,
  );

  // --- A gateway App renders through the same standard MCP App path, and skill creation is one click from a prompt.
  async function openSkillStudio() {
    await openAppsAndTools(app);
    await clickTestId(app, "apps-tools-row-connected");
    await clickTestId(app, "apps-tools-row-connected-apps");
    await waitFor(app, () => {
      const row = [...document.querySelectorAll('[data-testid="coworker-mcp-app"]')].find((candidate) => (candidate.textContent ?? "").includes("Skill studio"));
      if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("OpenWork Connect")) return false;
      row.click();
      return true;
    }, { timeoutMs: 120_000, label: "Skill studio App from OpenWork Connect" });
  }
  await openSkillStudio();
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-mcp-app-detail"] textarea') === null)).toBe(true);
  expect(await evalIn(app, () => document.querySelector('[data-testid="apps-tools-open-app"]') === null)).toBe(true);
  const appCallsBeforeDraft = gatewayCalls.filter((call) => call.endpoint === "connection" && call.method === "tools/call").length;
  await clickTestId(app, "apps-tools-ask");
  expect(String(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value ?? ""))).toBe("Help me use Skill studio to: ");
  expect(gatewayCalls.filter((call) => call.endpoint === "connection" && call.method === "tools/call").length).toBe(appCallsBeforeDraft);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await openSkillStudio();
  await clickTestId(app, "apps-tools-advanced-input");
  await fill(app, '[data-testid="coworker-mcp-app-detail"] textarea', '{"topic":"shared skills"}');
  await clickTestId(app, "apps-tools-open-app");
  await waitFor(app, browserScript((selector) => document.querySelector(selector)?.getAttribute("data-mcp-app-ready") === "true", [`[data-mcp-app-resource="${SKILL_APP_RESOURCE}"]`]), {
    timeoutMs: 120_000,
    label: "Skill studio App mounted",
  });
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "tools/call" && call.tool === SKILL_APP_TOOL && call.authorization === `Bearer ${APP_HOST_TOKEN}`)).toBe(true);
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "resources/read" && call.tool === SKILL_APP_RESOURCE)).toBe(true);
  await clickTestId(app, "panel-back");
  await clickTestId(app, "panel-back");
  await waitFor(app, browserScript((route) => document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === route, [`${APPS_TOOLS_ROUTE}/connected`]), { timeoutMs: 30_000, label: "back on the Connected screen" });
  await clickTestId(app, "coworker-connect-create-skill");
  const skillDraft = String(await waitFor(app, () => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("repeatable task") ? composer.value : false;
  }, { timeoutMs: 30_000, label: "create-skill message prefilled" }));
  expect(skillDraft).toBe("Help me turn a repeatable task into a skill for my team. The task is: ");
  expect(skillDraft).not.toMatch(/search_capabilities|execute_capability|MCP|conn_eval/);
  expect(await evalIn(app, () => [...document.querySelectorAll('[data-message-role="user"]')].length)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  evidence.recordAssertionEvidence(
    "Gateway Apps render and skill creation starts from the Connected screen",
    `The Skill studio App, published by an organization connection behind the Connect gateway, was listed under Connected › Apps with its OpenWork Connect source line, opened through the connection's own tools/call and resources/read, and mounted in the sandbox; two Backs returned to the Connected screen, where Create a skill prefilled Scout's discussion with a plain-language request about the repeatable task, without sending it.`,
    true,
  );

  // A failed discovery stays recoverable and cannot be cached as an empty account.
  await openAppsAndTools(app);
  gatewaySearchUnavailable = true;
  await waitFor(app, () => { const button = document.querySelector('button[aria-label="Refresh"]'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; }, { timeoutMs: 30_000, label: "refresh connected apps" });
  await waitForText(app, "Some connected apps and skills couldn't be loaded", { timeoutMs: 60_000 });
  expect(String(await evalIn(app, () => document.querySelector('[data-testid="coworker-capabilities"]')?.textContent ?? ""))).not.toContain("Your organization has not connected any services");
  gatewaySearchUnavailable = false;
  await new Promise((resolve) => setTimeout(resolve, 15_100));
  await evalIn(app, () => { window.dispatchEvent(new Event("online")); return true; });
  await waitFor(app, () => !document.querySelector('[data-testid="apps-tools-connect-problem"]') && document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled === false, { timeoutMs: 60_000, label: "catalog refreshed after the outage" });
  await clickTestId(app, "apps-tools-row-connected");
  await clickTestId(app, "apps-tools-row-connections");
  await waitForText(app, "Notion", { timeoutMs: 30_000 });
  await backToActivity(app);
  evidence.recordAssertionEvidence("Connected work starts with a task and discovery errors recover without configuration", "Task and app actions filled ordinary editable discussion drafts without a model request or app execution. An app requiring input showed no JSON editor by default; its advanced path still opened with validated input. A catalog failure showed a retry message and going back online refreshed the connection list without a manual configuration step.", true);

  // --- A real discussion turn on that model, with the credential delivered by the server, not the UI.
  const prompt = `Reply with exactly ${REPLY}.`;
  await fill(app, 'textarea[aria-label="Message Scout"]', prompt);
  await clickButton(app, "Send");
  const reply = await waitFor(app, browserScript((reply) => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(reply));
    return message?.textContent ?? false;
  }, [REPLY]), { timeoutMs: 300_000, label: "assistant reply from the organization model" });
  expect(String(reply)).toContain(REPLY);
  const replyModel = await waitFor(app, () => document.querySelector('[data-testid="coworker-reply-model"]')?.textContent ?? false, {
    timeoutMs: 30_000,
    label: "answering model attribution",
  });
  expect(String(replyModel)).toContain(MODEL_ID);
  expect(completionAuthorizations.length).toBeGreaterThanOrEqual(1);
  expect(completionAuthorizations.every((value) => value === `Bearer ${PROVIDER_API_KEY}`)).toBe(true);
  expect(connectedInstructionsSeen).toBe(true);
  await waitFor(app, () => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready", {
    timeoutMs: 60_000,
    label: "coworker settles to Ready after a matched reply",
  });

  evidence.recordAssertionEvidence(
    "A discussion turn runs on the organization model with the account's credential and is attributed honestly",
    `Scout answered "${REPLY}" through ${PROVIDER_RECORD_ID}/${MODEL_ID}; the mock provider saw ${completionAuthorizations.length} completion request(s), each authorized with the credential Den granted, and the reply carried the model attribution before the thread reported Ready.`,
    true,
  );

  // Voice is opt-in, member-scoped, and independent of the selected answer model.
  const voiceAdmissionOffset = denRequests.filter((entry) => entry.path === "/v1/voice").length;
  const voiceRequests = () => denRequests.filter((entry) => entry.path === "/v1/voice" || entry.path.startsWith("/v1/voice/")).slice(voiceAdmissionOffset);
  expect(voiceRequests()).toEqual([]);
  const completionsBeforeVoice = completionAuthorizations.length;
  const usersBeforeVoice = await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length);
  membershipResponse = "unpaid";
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="voice-membership"]')), { timeoutMs: 15_000, label: "voice Models upsell for an unpaid member" });
  expect(voiceRequests()).toEqual([{ method: "GET", path: "/v1/voice", authorization: `Bearer ${SESSION_TOKEN}`, org: ORG_ID }]);
  expect(await capture.read()).toMatchObject({ calls: 0, tracks: [], rendererVoiceRequests: 0 });
  expect(await evalIn(app, () => document.querySelector('[data-testid="voice-panel"]') === null)).toBe(true);
  await clickCoworkerControl(app, { role: "button", label: "Explore Models membership" });
  await waitForText(app, "No active Models membership", { timeoutMs: 30_000 });
  expect(denRequests.some((entry) => entry.method === "POST" && /billing|checkout/.test(entry.path))).toBe(false);
  expect(voiceRequests()).toHaveLength(1);
  expect(completionAuthorizations).toHaveLength(completionsBeforeVoice);
  membershipResponse = "active";
  await clickCoworkerControl(app, { role: "button", label: /Back to coworkers/ });
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "idle", { timeoutMs: 15_000, label: "paid member voice readiness" });
  expect(voiceRequests()).toEqual(Array(2).fill({ method: "GET", path: "/v1/voice", authorization: `Bearer ${SESSION_TOKEN}`, org: ORG_ID }));
  expect(await capture.read()).toMatchObject({ calls: 0, tracks: [], rendererVoiceRequests: 0 });
  expect(speeches).toEqual([]); // Enabling voice must not replay the existing ACCOUNT MODEL READY reply.

  // Deliberately untrusted IPC is a negative boundary probe, not a simulated user gesture.
  await waitFor(app, () => !navigator.userActivation.isActive, { timeoutMs: 10_000, label: "the real click's transient activation expires" });
  expect(await invokeCoworker(app, "voice.microphone", {})).toEqual({ ok: false, error: "Click the microphone control to allow audio input." });
  evidence.recordAssertionEvidence(
    "Voice readiness is a native member read, not checkout or microphone consent",
    "The unpaid member saw the Models upsell and navigated to membership without checkout, capture, speech, or a completion. The paid member made only GET /v1/voice with the session and organization; no renderer voice HTTP request occurred, existing replies stayed silent, and native IPC rejected microphone access without a gesture.", true,
  );

  const voiceDraft = "Keep this unfinished request for my return.";
  await fill(app, 'textarea[aria-label="Message Scout"]', voiceDraft);
  if (!(await capture.read()).supported) {
    capturePrerequisite = "native browser audio capture and a supported MediaRecorder codec";
  } else {
    await clickCoworkerControl(app, { testId: "voice-record" });
    const recording = await waitFor(app, () => {
      if (document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "recording") return "recording";
      const status = document.querySelector('[data-testid="voice-status"]')?.textContent ?? "";
      return /Microphone access was not granted|No microphone was found|Voice is unavailable/.test(status) ? status : false;
    }, { timeoutMs: 30_000, label: "real native microphone consent and browser fake-device recording" });
    if (process.platform === "darwin" && String(recording).includes("Microphone access was not granted") && (await capture.read()).calls === 0) {
      capturePrerequisite = "macOS microphone permission for the exact Coworker binary (not bypassed by fake media)";
      console.warn(`Recording prerequisite: ${capturePrerequisite}. Allow Open Coworker in System Settings > Privacy & Security > Microphone, then rerun this exact binary.`);
    } else {
      expect(recording).toBe("recording");
      // Wait for a real recorder timeslice rather than finishing before it has any audio.
      await waitFor(app, () => (document.querySelector('[data-testid="voice-timer"]')?.textContent ?? "").startsWith("0:01"), { timeoutMs: 5_000, label: "one second of browser capture" });
      await clickCoworkerControl(app, { testId: "voice-record" });
      await waitForText(app, "Added to your draft", { timeoutMs: 15_000 });
      expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(`${voiceDraft}\n${TRANSCRIPT}`);
      expect(transcriptions).toHaveLength(1);
      expect(transcriptions[0]).toEqual({ input_audio: { data: expect.any(String), format: expect.stringMatching(/^(webm|m4a)$/) } });
      const transcription = transcriptions[0];
      if (!isRecord(transcription) || !isRecord(transcription.input_audio) || typeof transcription.input_audio.data !== "string") throw new Error("Missing native transcription audio");
      const recordedBytes = Buffer.from(transcription.input_audio.data, "base64");
      expect(recordedBytes.length).toBeGreaterThan(0);
      expect(recordedBytes.length).toBeLessThanOrEqual(3 * 1024 * 1024);
      expect(recordedBytes.toString("base64")).toBe(transcription.input_audio.data);
      expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(usersBeforeVoice);
      expect(completionAuthorizations).toHaveLength(completionsBeforeVoice);
      const stopped = await capture.read();
      expect(stopped.calls).toBe(1);
      expect(stopped.tracks).toEqual([{ kind: "audio", state: "ended" }]);
      expect(stopped.clicks.filter((click) => click.control === "voice-record")).toEqual(Array(2).fill({ control: "voice-record", trusted: true, active: true }));
      expect(stopped.rendererVoiceRequests).toBe(0);

      await clickCoworkerControl(app, { testId: "voice-record" });
      await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "recording", { timeoutMs: 15_000, label: "second recording before navigation" });
      await clickCoworkerControl(app, { role: "button", label: new RegExp(ORG_NAME) });
      await waitForText(app, "OpenWork settings", { timeoutMs: 15_000 });
      await eventually(async () => (await capture.read()).tracks.every((track) => track.state === "ended"), { within: 5_000, label: "navigation releases the real audio tracks" });
      await clickCoworkerControl(app, { role: "button", label: /Back to coworkers/ });
      expect(transcriptions).toHaveLength(1);
      expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(`${voiceDraft}\n${TRANSCRIPT}`);
      expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(usersBeforeVoice);
      expect(completionAuthorizations).toHaveLength(completionsBeforeVoice);
      await clickCoworkerControl(app, { testId: "voice-toggle" });
      await waitForText(app, "Voice ready", { timeoutMs: 15_000 });
      evidence.recordAssertionEvidence(
        "Real recording appends an editable transcript and navigation discards unfinished audio",
        "Trusted microphone clicks crossed preload/native consent and captured the browser's fake audio device. Native POST /v1/voice/transcriptions carried bounded base64 audio, appended the transcript without replacing the original draft or sending a turn, and stopped the audio track. Navigating during a second recording ended its tracks without another transcription or completion.", true,
      );
    }
  }

  // Only a new final reply is eligible. Hold the provider stream, then hold speech to witness native abort.
  await fill(app, 'textarea[aria-label="Message Scout"]', "Give me the next step for our voice reply check.");
  await clickCoworkerControl(app, { role: "button", label: /^Send$/ });
  await waitForText(app, VOICE_REPLY, { timeoutMs: 120_000 });
  expect(speeches).toEqual([]);
  if (!voiceCompletion.finish) throw new Error("The model witness has no pending final reply");
  voiceCompletion.finish();
  await eventually(() => speeches.length, { within: 30_000, until: (count) => count === 1, label: "one native speech request for the new final reply" });
  expect(speeches.map((speech) => speech.body)).toEqual([{ input: VOICE_SENTENCES[0] }]);
  await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "preparing", { timeoutMs: 15_000, label: "speech awaiting native response" });
  await fill(app, 'textarea[aria-label="Message Scout"]', voiceDraft);
  await clickCoworkerControl(app, { testId: "voice-cancel" });
  await eventually(() => speeches[0]?.cancelled, { within: 5_000, label: "Stop audio aborts native HTTP transport" });
  await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "idle", { timeoutMs: 5_000, label: "voice idle after cancellation" });
  expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(voiceDraft);
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await waitForText(app, "Voice ready", { timeoutMs: 15_000 });
  expect(speeches.map((speech) => speech.body)).toEqual([{ input: VOICE_SENTENCES[0] }]);
  expect(voiceRequests().every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  expect(await capture.read()).toMatchObject({ rendererVoiceRequests: 0 });
  expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(usersBeforeVoice + 1);
  await waitForText(app, VOICE_REPLY, { timeoutMs: 5_000 });
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "scout" })).model).toBe(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);
  evidence.recordAssertionEvidence(
    "Only the new final reply requests speech, and Stop audio cancels native transport",
    "The streaming reply and its reasoning made no speech request. Completion caused exactly one native POST /v1/voice/speech containing only the new visible final text, never history or reasoning. Stop audio closed the held HTTP response, kept the draft and text reply, and toggling voice back on did not replay it. This proves synthesis admission/cancellation, not decoded audio playback.", true,
  );

  holdSpeech = false;
  for (const stopPlayback of [false, true]) {
    const firstSource = (await capture.read()).playback.length;
    const requestsBefore = speeches.length;
    voiceCompletion.finish = undefined;
    await fill(app, 'textarea[aria-label="Message Scout"]', `Another voice reply check, ${stopPlayback ? "stop" : "finish"} playback.`);
    await clickCoworkerControl(app, { role: "button", label: /^Send$/ });
    await eventually(() => Boolean(voiceCompletion.finish), { within: 60_000, label: "new model stream awaits completion" });
    expect(speeches).toHaveLength(requestsBefore);
    voiceCompletion.finish?.();
    await waitFor(app, browserScript((sentence) => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "speaking" && document.querySelector('[data-testid="voice-caption"]')?.textContent?.includes(sentence), [VOICE_SENTENCES[0]]), { timeoutMs: 30_000, label: "first sentence decoded and captioned" });
    await eventually(async () => (await capture.read()).playback[firstSource]?.progress ?? 0, { within: 5_000, until: (seconds) => seconds > 0.2, label: "real AudioContext clock advances during playback" });
    const playing = (await capture.read()).playback[firstSource];
    expect(playing).toMatchObject({ state: "running", destination: true, hasSignal: true, stopped: false, ended: null, disconnected: false });
    expect(playing?.duration).toBeGreaterThan(2);
    expect(playing?.progress).toBeLessThan(playing?.duration ?? 0);
    if (stopPlayback) {
      await fill(app, 'textarea[aria-label="Message Scout"]', voiceDraft);
      await clickCoworkerControl(app, { testId: "voice-cancel" });
      await eventually(async () => (await capture.read()).playback[firstSource]?.state, { within: 5_000, until: (state) => state === "closed", label: "Stop closes the playing AudioContext" });
      expect((await capture.read()).playback[firstSource]).toMatchObject({ stopped: true, disconnected: true, state: "closed" });
      expect(speeches).toHaveLength(requestsBefore + 1);
      expect(await evalIn(app, () => document.querySelector('[data-testid="voice-caption"]') === null)).toBe(true);
      expect(await evalIn(app, () => document.activeElement?.getAttribute("aria-label"))).toBe("Message Scout");
      expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe(voiceDraft);
    } else {
      await waitFor(app, browserScript((sentence) => document.querySelector('[data-testid="voice-caption"]')?.textContent?.includes(sentence), [VOICE_SENTENCES[1]]), { timeoutMs: 10_000, label: "caption advances to the next sentence" });
      await waitForText(app, "Spoken reply finished.", { timeoutMs: 10_000 });
      const finished = (await capture.read()).playback.slice(firstSource);
      expect(finished).toHaveLength(2);
      for (const source of finished) {
        expect(source).toMatchObject({ state: "closed", destination: true, hasSignal: true, stopped: false, disconnected: true });
        expect((source.ended ?? 0) - (source.started ?? 0)).toBeGreaterThanOrEqual(source.duration - 0.1);
      }
      expect(speeches.slice(requestsBefore).map((speech) => speech.body)).toEqual(VOICE_SENTENCES.map((input) => ({ input })));
    }
    await waitFor(app, () => document.querySelector('[data-testid="voice-panel"]')?.getAttribute("data-phase") === "idle", { timeoutMs: 5_000, label: "playback returns to idle" });
  }
  expect(await capture.read()).toMatchObject({ rendererVoiceRequests: 0 });
  await waitForText(app, VOICE_REPLY, { timeoutMs: 5_000 });
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  evidence.recordAssertionEvidence("Native MP3 playback progresses, updates sentence captions, ends, and stops cleanly", "The real native response delivered a valid deterministic MP3 tone. AudioContext decoded nonzero samples, connected them to its destination, advanced its running clock, and naturally ended both sentence buffers while the caption advanced. A later Stop stopped and disconnected its playing source, closed the context, cleared captions, restored draft focus, and suppressed the next sentence without changing the text reply. This proves playback mechanics, not acoustic or speech quality.", true);

  // --- Reload: unsent work, account, providers, and selection persist.
  await fill(app, 'textarea[aria-label="Message Scout"]', "Keep this unfinished request for my return.");
  await evalIn(app, () => { location.reload(); return true; });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout"), { timeoutMs: 120_000, label: "Scout discussion view" });
  await waitForText(app, REPLY, { timeoutMs: 60_000 });
  expect(await evalIn(app, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]')?.value)).toBe("Keep this unfinished request for my return.");
  expect(String(await evalIn(app, () => [...document.querySelectorAll('[data-message-role="user"]')].map((element) => element.textContent).join("\n")))).not.toContain("Keep this unfinished request for my return.");
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  await clickButtonContaining(app, ORG_NAME);
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "Account");
  await waitFor(app, () => document.querySelector('[data-testid="account-status"]')?.textContent === "OpenWork connected", {
    timeoutMs: 30_000,
    label: "connected account status",
  });
  const accountText = String(await evalIn(app, () => document.querySelector<HTMLElement>('[data-testid="account-card"]')?.innerText ?? ""));
  expect(accountText).toContain(ORG_NAME);
  expect(accountText).toContain("member@eval.example");
  expect(accountText).not.toContain(SESSION_TOKEN);
  await clickButton(app, "AI models");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="cloud-providers"]')), { timeoutMs: 60_000, label: "OpenWork Cloud provider group" });
  // The group appears while the account's models are still being read; wait for the provider itself.
  await waitForText(app, "Eval Org Provider", { timeoutMs: 60_000 });
  const modelsText = String(await evalIn(app, () => document.body.innerText));
  expect(modelsText).toContain("Eval Org Provider");
  expect(modelsText).toContain(PROVIDER_RECORD_ID);
  expect(modelsText).not.toContain(PROVIDER_API_KEY);

  await waitForText(app, "Membership active", { timeoutMs: 30_000 });
  const membershipText = String(await evalIn(app, () => document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""));
  expect(membershipText).toContain("75% left");
  expect(membershipText).toContain("Waiting for refreshed usage");
  expect(membershipText).toContain("Manage membership");
  expect(membershipText).not.toMatch(/free credits|launch offer|limited offer|guaranteed faster/);
  expect(denRequests.filter((entry) => entry.path === "/v1/inference").every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  membershipResponse = "unavailable";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Membership status is unavailable", { timeoutMs: 30_000 });
  expect(String(await evalIn(app, () => document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""))).not.toContain("No active Models membership");
  membershipResponse = "admin";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Your workspace admin manages the membership", { timeoutMs: 30_000 });
  membershipResponse = "unpaid";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "No active Models membership", { timeoutMs: 30_000 });
  const unpaidText = String(await evalIn(app, () => document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""));
  expect(unpaidText).toContain("View models & pricing");
  expect(unpaidText).not.toMatch(/Manage membership|75% left|Membership active/);
  membershipResponse = "setup";
  await clickButton(app, "Refresh membership & models");
  await waitForText(app, "Membership active · setup needs attention", { timeoutMs: 30_000 });
  const setupText = String(await evalIn(app, () => document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""));
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
  await waitFor(app, () => document.querySelector('[data-testid="account-status"]')?.textContent === "Local mode", {
    timeoutMs: 60_000,
    label: "signed-out account status",
  });
  expect(await evalIn(app, () => window.localStorage.getItem("coworker.den.session.v1"))).toBeNull();
  await clickButton(app, "AI models");
  // The sweep reloads the engine asynchronously; re-read the catalog until the account group is gone.
  await waitFor(app, () => document.querySelector('[data-testid="models-membership"]')?.getAttribute("data-state") === "signed-out", { timeoutMs: 30_000, label: "membership clears on sign-out" });
  expect(String(await evalIn(app, () => document.querySelector('[data-testid="models-membership"]')?.textContent ?? ""))).not.toMatch(/Membership active|75% left/);
  const sweepDeadline = Date.now() + 180_000;
  for (;;) {
    const swept = await evalIn(app, () => {
      const body = document.body.innerText;
      return !document.querySelector('[data-testid="cloud-providers"]')
        && !body.includes("Reading OpenWork models")
        && (Boolean(document.querySelector('[data-testid="local-providers"]'))
          || body.includes("No connected provider models are available"));
    });
    if (swept === true) break;
    if (Date.now() > sweepDeadline) throw new Error("Organization providers were still listed 180s after sign-out.");
    await clickButton(app, "Refresh", { timeoutMs: 30_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await clickButtonContaining(app, "Back to coworkers");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout"), { timeoutMs: 60_000, label: "Scout discussion view" });
  const gatewayAfterSignOut = await evalIn(app, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    const runtime = await bridge.invoke("runtime.info");
    const scout = await bridge.invoke("coworkers.get", { slug: "scout" });
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(scout.result.workspaceId) + "/mcp/openwork-cloud/health", {
      headers: { Authorization: "Bearer " + runtime.result.ownerToken },
    });
    const health: { desired?: { present?: boolean } } | null = await response.json().catch(() => null);
    return { status: response.status, present: health?.desired?.present ?? null };
  }, { awaitPromise: true, timeoutMs: 60_000 });
  expect(isRecord(gatewayAfterSignOut) && (gatewayAfterSignOut.status === 404 || gatewayAfterSignOut.present === false)).toBe(true);
  await openAppsAndTools(app);
  await waitFor(app, () => (document.querySelector('[data-testid="apps-tools-row-connected"]')?.textContent ?? "").includes("Not connected"), {
    timeoutMs: 30_000,
    label: "the Connected with OpenWork row reads Not connected",
  });
  await backToActivity(app);
  const beforeSignedOutVoice = voiceRequests().length;
  const completionsBeforeSignedOutVoice = completionAuthorizations.length;
  const signedOutCapture = await capture.read();
  await clickCoworkerControl(app, { testId: "voice-toggle" });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="voice-membership"]')), { timeoutMs: 15_000, label: "signed-out voice Models upsell" });
  expect(voiceRequests()).toHaveLength(beforeSignedOutVoice);
  expect(await capture.read()).toMatchObject({ calls: signedOutCapture.calls, tracks: signedOutCapture.tracks, rendererVoiceRequests: 0 });
  expect(await evalIn(app, () => document.querySelector('[data-testid="voice-panel"]') === null)).toBe(true);
  expect(denRequests.some((entry) => entry.method === "POST" && /billing|checkout/.test(entry.path))).toBe(false);
  expect(completionAuthorizations).toHaveLength(completionsBeforeSignedOutVoice);
  evidence.recordAssertionEvidence("Signed-out voice stays an upsell, not an audio operation", "Clicking Voice mode after sign-out showed Models membership without any voice HTTP request, capture, or checkout and without exposing recording controls.", true);
  await fill(app, 'textarea[aria-label="Message Scout"]', "Reply with exactly SIGNED OUT.");
  await clickButton(app, "Send");
  const failureText = String(await waitFor(app, () => document.querySelector('[data-testid="coworker-turn-failed"]')?.textContent ?? false, {
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
    `Sign out cleared the session, removed the account's providers and gateway, and left Apps & tools Not connected. The next discussion turn failed with ${PROVIDER_RECORD_ID}/${MODEL_ID} unavailable because no account was signed in, with sign-in and model-selection actions.`,
    true,
  );

  // A new teammate receives a prepared team through the same account handoff.
  await capture[Symbol.asyncDispose]();
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
  await using teammateApp = await isolatedAccountCoworker("assigned-team", denBaseUrl);
  await clickTestId(teammateApp, "onboarding-cloud-choice");
  await waitForText(teammateApp, "Continue with OpenWork", { timeoutMs: 120_000 });
  await fill(teammateApp, 'input[placeholder^="opencoworker://den-auth"]', `opencoworker://den-auth?grant=${GRANT}&denBaseUrl=${encodeURIComponent(denBaseUrl)}`);
  await clickButton(teammateApp, "Connect");
  await waitFor(teammateApp, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && document.body.innerText.includes("Campaign partner"), { timeoutMs: 180_000, label: "assigned coworkers ready after first sign-in" });
  const readTeam = () => evalIn(teammateApp, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return (await bridge.invoke("coworkers.list")).result.map(({slug, name, model, automations}) => ({slug, name, model, automations}));
  }, { awaitPromise: true });
  expect(await readTeam()).toEqual([
    expect.objectContaining({ name: "Campaign partner", automations: [] }),
    expect.objectContaining({ name: "Research partner", automations: [] }),
  ]);
  const initialSoul = await evalIn(teammateApp, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return (await bridge.invoke("coworkers.files.read", {slug:"campaign-partner", path:"soul.md"})).result.content;
  }, { awaitPromise: true });
  expect(initialSoul).toContain(startingTemplate.instructions);
  expect(completionAuthorizations.length).toBe(starts);
  expect(denRequests.filter((entry) => entry.path === "/v1/me/coworkers").every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  evidence.recordAssertionEvidence("An assigned team is ready on first account sign-in", "A fresh Open Coworker profile signed in through the real handoff and displayed Campaign partner and Research partner without manual creation. The reusable instructions were installed; optional and catalog-only coworkers were not created. No scheduled work was imported, and provisioning made no completion requests.", true);

  await evalIn(teammateApp, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return bridge.invoke("coworkers.files.write", {slug:"campaign-partner", path:"memory/working.md", content:"My campaign work stays here."});
  }, { awaitPromise: true });
  assignedTemplates[0] = { ...assignedTemplates[0], versionId: "two", template: { ...startingTemplate, name: "Campaign partner", instructions: "New instructions for future copies." } };
  await evalIn(teammateApp, () => { location.reload(); return true; });
  await waitFor(teammateApp, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')), { timeoutMs: 120_000, label: "assigned team after reload" });
  await clickButtonContaining(teammateApp, ORG_NAME);
  await clickButton(teammateApp, "Account");
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitForText(teammateApp, "Template updated · your working copy is preserved", { timeoutMs: 120_000 });
  expect(await readTeam()).toHaveLength(2);
  const preserved = await evalIn(teammateApp, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    const read = async (path: string) => (await bridge.invoke("coworkers.files.read", {slug:"campaign-partner", path})).result.content;
    return { memory: await read("memory/working.md"), soul: await read("soul.md") };
  }, { awaitPromise: true });
  expect(preserved).toMatchObject({ memory: "My campaign work stays here.", soul: expect.stringContaining(startingTemplate.instructions) });
  await waitFor(teammateApp, () => { const button = document.querySelector('[data-template-id="optional"] button'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; }, { timeoutMs: 30_000, label: "add an optional assigned coworker" });
  await waitFor(teammateApp, () => document.querySelector('[data-template-id="optional"]')?.textContent?.includes("Already added"), { timeoutMs: 120_000, label: "optional coworker added" });
  expect(await readTeam()).toHaveLength(3);
  await evalIn(teammateApp, async () => {
    const bridge = Reflect.get(window, "__COWORKER__") as CoworkerTestBridge;
    return bridge.invoke("coworkers.delete", {slug:"research-partner"});
  }, { awaitPromise: true });
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitFor(teammateApp, () => !document.querySelector<HTMLButtonElement>('[data-testid="assigned-coworkers"] button')?.disabled, { timeoutMs: 120_000, label: "assignment refresh after retirement" });
  expect(await readTeam()).toHaveLength(2);
  expect(completionAuthorizations.length).toBe(starts);
  coworkerTeamsEnabled = false;
  await clickButton(teammateApp, "Refresh assigned coworkers");
  await waitFor(teammateApp, () => document.querySelector('[data-testid="assigned-coworkers"]')?.textContent?.includes("Coworker templates") && !document.querySelector('[data-template-id="optional"]'), { timeoutMs: 30_000, label: "disabled team controls hidden" });
  expect(await readTeam()).toHaveLength(2);
  expect(await evalIn(teammateApp, () => document.body.innerText.includes("Refresh assigned coworkers"))).toBe(false);
  coworkerTeamsEnabled = true;
  await clickButton(teammateApp, "General");
  await clickButton(teammateApp, "Account");
  await waitForText(teammateApp, "Refresh assigned coworkers", { timeoutMs: 30_000 });
  expect(await readTeam()).toHaveLength(2);
  evidence.recordAssertionEvidence("Turning prepared teams off hides their controls while keeping personal coworkers", "The disabled catalog deliberately still contained templates; the client failed closed on enabled=false, hid team controls, and preserved both personal coworkers. Returning to Account after re-enabling discovered the flag and restored the controls without duplicates.", true);
  evidence.recordAssertionEvidence("Refreshes preserve personal work, optional choices, and retirement", "After a version update and reload, the team still had two coworkers and Account explained the preserved working copy. Original starting instructions and edited working memory were unchanged. Explicitly adding an optional coworker created one copy; retiring another and refreshing did not recreate it. No background completion requests were made.", true);
  if (capturePrerequisite) skip(`needs: ${capturePrerequisite}; recording assertions were not executed`);
});
