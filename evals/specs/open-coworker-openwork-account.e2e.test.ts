import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";
import { buildGeneratedArtifactViewInWorker } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";

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
  ? "Open Coworker signs in with an OpenWork account, gains OpenWork Connect, and runs a discussion turn on an organization model"
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

/**
 * A deterministic stand-in for the OpenWork Connect gateway (`/mcp/agent`):
 * the two capability tools every OpenWork client relies on, one built-in
 * skill behind them, and one standard MCP App so the coworker's Apps & tools
 * surface has something real to render.
 */
const skillApp = await buildGeneratedArtifactViewInWorker({
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
if (!skillApp.ok) throw new Error(`Connect App build failed: ${JSON.stringify(skillApp.diagnostics)}`);
const skillAppHtml = skillApp.html;

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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ matches: [{ name: "skill:create-skill", kind: "skill", title: "Create Skill", description: "Create a new OpenWork Cloud skill." }] }) }],
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
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { ui: { resourceUri: SKILL_APP_RESOURCE } },
        }],
      },
    };
  }
  if (message.method === "tools/call" && params.name === SKILL_APP_TOOL) {
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

/** Bring the right panel to the Apps & tools view from whatever state it is in (folded, another view, or Activity). */
async function openAppsAndTools(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "capabilities") return true;
    if (panel.dataset.collapsed === "true") {
      document.querySelector('[data-testid="context-rail-capabilities"]')?.click();
      return false;
    }
    if (panel.dataset.view !== "overview") {
      document.querySelector('button[aria-label="Back to activity"]')?.click();
      return false;
    }
    const link = [...document.querySelectorAll('nav[aria-label="More for this coworker"] button')]
      .find((button) => (button.textContent ?? "").includes("Apps & tools"));
    link?.click();
    return false;
  })()`, { timeoutMs: 60_000, label: "Apps & tools view" });
}

/** Open the right panel on its Activity view (it starts folded and closes when the coworker changes). */
async function openDetails(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "overview") return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-overview"]')?.click();
    else document.querySelector('button[aria-label="Back to activity"]')?.click();
    return false;
  })()`, { timeoutMs: 60_000, label: "Activity view" });
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });

  // --- Mock organization model: an OpenAI-compatible endpoint that answers deterministically.
  const completionAuthorizations: string[] = [];
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
          const reply = isGateway ? gatewayResponse(candidate) : connectionResponse(candidate);
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

  // The exchange happened against the mock Den and the account moved on to coworker creation.
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
  await openDetails(app);
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="coworker-settings-button"]');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Coworker settings icon button" });
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
  await waitFor(app, `(() => {
    const back = document.querySelector('button[aria-label="Back to activity"]');
    if (!(back instanceof HTMLElement)) return false;
    back.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "back to the Activity sidebar" });

  evidence.recordAssertionEvidence(
    "The organization's model reaches Coworker settings labelled by source, without a model step in creation",
    `Scout was created from a name alone; in Coworker settings the picker grouped ${MODEL_NAME} under Eval Org Provider with an OpenWork Cloud tag and a summary naming ${ORG_NAME}, and selecting it persisted ${PROVIDER_RECORD_ID}/${MODEL_ID} on Scout.`,
    true,
  );

  // --- OpenWork Connect reaches the coworker: one minted gateway token, the gateway registered in Scout's
  // workspace, and the Apps & tools surface reporting it in plain words.
  await openAppsAndTools(app);
  const connectSettled = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="coworker-connect-card"]');
    const status = card?.getAttribute("data-status") ?? "";
    if (!status || status === "connecting") return false;
    return { status, detail: document.querySelector('[data-testid="coworker-connect-detail"]')?.textContent ?? "" };
  })()`, { timeoutMs: 240_000, label: "OpenWork Connect settled for Scout" });
  expect(connectSettled, `Connect card: ${JSON.stringify(connectSettled)}`).toMatchObject({ status: "connected" });
  const connectCard = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="coworker-connect-card"]');
    if (!(card instanceof HTMLElement) || card.getAttribute("data-status") !== "connected") return false;
    return {
      text: card.innerText,
      status: document.querySelector('[data-testid="coworker-connect-status"]')?.textContent?.trim() ?? "",
      askEnabled: [...card.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Ask Scout" && !button.disabled),
      createSkillEnabled: !(card.querySelector('[data-testid="coworker-connect-create-skill"]')?.disabled ?? true),
    };
  })()`, { timeoutMs: 240_000, label: "OpenWork Connect connected for Scout" });
  expect(connectCard).toMatchObject({ status: "Connected", askEnabled: true, createSkillEnabled: true });
  if (!isRecord(connectCard) || typeof connectCard.text !== "string") throw new Error("Connect card facts were unavailable.");
  expect(connectCard.text).toContain(ORG_NAME);
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
    `After sign-in the app minted ${mintedTokens} gateway token(s) and registered the gateway at ${denBaseUrl}/mcp/agent in Scout's workspace; the embedded server reported it usable with both capability tools present, every gateway call carried the minted bearer token, and the Apps & tools card read Connected for ${ORG_NAME} with Ask Scout and Create a skill enabled and no MCP vocabulary.`,
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
  await waitFor(app, `(() => {
    const card = [...document.querySelectorAll('[data-testid="coworker-mcp-app"]')].find((candidate) => (candidate.textContent ?? "").includes("Skill studio"));
    if (!(card instanceof HTMLElement)) return false;
    card.click();
    return true;
  })()`, { timeoutMs: 120_000, label: "Skill studio App from OpenWork Connect" });
  await clickButton(app, "Open App", { timeoutMs: 30_000 });
  await waitFor(app, `document.querySelector(${json(`[data-mcp-app-resource="${SKILL_APP_RESOURCE}"]`)})?.getAttribute("data-mcp-app-ready") === "true"`, {
    timeoutMs: 120_000,
    label: "Skill studio App mounted",
  });
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "tools/call" && call.tool === SKILL_APP_TOOL && call.authorization === `Bearer ${APP_HOST_TOKEN}`)).toBe(true);
  expect(gatewayCalls.some((call) => call.endpoint === "connection" && call.method === "resources/read" && call.tool === SKILL_APP_RESOURCE)).toBe(true);
  await clickButton(app, "← All Apps");
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="coworker-connect-create-skill"]');
    if (!(button instanceof HTMLElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Create a skill" });
  const skillDraft = String(await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("create-skill") ? composer.value : false;
  })()`, { timeoutMs: 30_000, label: "create-skill message prefilled" }));
  expect(skillDraft).toContain('Search capabilities for "create skill"');
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].length`)).toBe(0);
  await fill(app, 'textarea[aria-label="Message Scout"]', "");
  evidence.recordAssertionEvidence(
    "Gateway Apps render and skill creation starts from the Apps & tools surface",
    `The Skill studio App, published by an organization connection behind the Connect gateway, was discovered through the gateway's connection index with the app-host token, opened through the connection's own tools/call and resources/read, and mounted in the sandbox; Create a skill prefilled Scout's discussion with a search-first create-skill request without sending it.`,
    true,
  );

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
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 60_000,
    label: "coworker settles to Ready after a matched reply",
  });

  evidence.recordAssertionEvidence(
    "A discussion turn runs on the organization model with the account's credential and is attributed honestly",
    `Scout answered "${REPLY}" through ${PROVIDER_RECORD_ID}/${MODEL_ID}; the mock provider saw ${completionAuthorizations.length} completion request(s), each authorized with the credential Den granted, and the reply carried the model attribution before the thread reported Ready.`,
    true,
  );

  // --- Reload: account, providers, and selection all persist; settings explain the source of every provider.
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 120_000, label: "Scout discussion view" });
  await waitForText(app, REPLY, { timeoutMs: 60_000 });
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
  const modelsText = String(await evalIn(app, "document.body.innerText"));
  expect(modelsText).toContain("Eval Org Provider");
  expect(modelsText).toContain(PROVIDER_RECORD_ID);
  expect(modelsText).not.toContain(PROVIDER_API_KEY);

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
  await waitFor(app, `document.querySelector('[data-testid="coworker-connect-card"]')?.getAttribute("data-status") === "signed-out"`, {
    timeoutMs: 30_000,
    label: "Connect card back to its signed-out pitch",
  });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="coworker-connect-card"]')?.innerText ?? ""`))).toContain("Continue with OpenWork");
  await waitFor(app, `(() => {
    const back = document.querySelector('button[aria-label="Back to activity"]');
    if (!(back instanceof HTMLElement)) return false;
    back.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "back to the Activity sidebar" });
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
    `After Sign out the settings showed Local mode with no OpenWork Cloud group, and the next discussion turn failed visibly with a plain headline, naming ${PROVIDER_RECORD_ID}/${MODEL_ID} in the detail, explaining that no account is signed in, with Continue with OpenWork and Choose AI model actions.`,
    true,
  );
});
