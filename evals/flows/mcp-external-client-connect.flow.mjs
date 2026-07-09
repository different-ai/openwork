import http from "node:http";
import crypto from "node:crypto";
import { denApiUrl, denWebUrl } from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-external-client-connect";
const MCP_PATH = "/mcp/agent";
const REDIRECT_PORT = 8917;
const REDIRECT_URI = "http://127.0.0.1:8917/callback";
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";
const CLIENT_SCOPE = "openid profile email mcp:read mcp:write";
const CLIENT_NAME = "OpenWork eval URL-only MCP client";
const EXPECTED_AGENT_TOOLS = ["execute_capability", "search_capabilities"];

// Narration is loaded from the approved script (evals/voiceovers/mcp-external-client-connect.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  unauthenticatedInitialize: null,
  protectedResourceMetadataUrl: "",
  protectedResourceMetadata: null,
  authorizationServerMetadataUrl: "",
  authorizationServerMetadata: null,
  pkce: null,
  oauthState: "",
  loopback: null,
  registration: null,
  authorizeUrl: "",
  authorizationCode: "",
  tokenExchange: null,
  accessToken: "",
  mcpInitializeResult: null,
  toolsListResult: null,
  searchPayload: null,
  executePayload: null,
  organizationName: "",
};

let loopbackPage = {
  status: "waiting for authorization",
  details: ["OpenWork MCP client is waiting for the browser callback."],
};

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Desktop viewport skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => {
    ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function apiBaseUrl() {
  return denApiUrl();
}

function webBaseUrl() {
  return denWebUrl();
}

function initializeParams() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
  };
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readString(value, key) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function readFirstText(result) {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "";
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redactToken(token) {
  if (!token) return "";
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: text };
  }
}

function parseResourceMetadataChallenge(header) {
  const match = header.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i);
  return match?.[1] ?? match?.[2] ?? "";
}

function protectedResourceMetadataBrowserUrl() {
  return `${apiBaseUrl()}${MCP_PATH}/.well-known/oauth-protected-resource`;
}

async function navigateBrowser(ctx, url, label = "page") {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(url)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label });
}

async function clearDenWebSession(ctx) {
  await navigateBrowser(ctx, webBaseUrl(), "den-web before sign-out");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .catch(() => null)
      .then(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      })`,
    { awaitPromise: true },
  );
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => {
      ctx.log(`Cookie clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function waitForSignInForm(ctx) {
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "sign-in copy" });
  await ctx.waitFor(
    "Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]')) && Boolean(document.querySelector('input[type=\"password\"]'))",
    { timeoutMs: 30_000, label: "email + password fields" },
  );
  const submitIsSignIn = await ctx.eval(`(() => {
    const submit = document.querySelector('button[type="submit"]');
    return (submit?.textContent ?? '').includes('Sign in');
  })()`);
  if (!submitIsSignIn) {
    await ctx.eval(`(() => {
      const button = [...document.querySelectorAll('button, a')].find((entry) => (entry.textContent ?? '').trim() === 'Sign in');
      button?.click();
      return Boolean(button);
    })()`);
    await ctx.waitFor(
      "(document.querySelector('button[type=\"submit\"]')?.textContent ?? '').includes('Sign in')",
      { timeoutMs: 10_000, label: "sign-in form selected" },
    );
  }
}

async function submitSignIn(ctx) {
  await waitForSignInForm(ctx);
  await ctx.fill('input[type="email"], input[name="email"]', DEMO_EMAIL);
  await ctx.fill('input[type="password"]', DEMO_PASSWORD);
  const submitted = await ctx.waitFor(`(() => {
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => !button.disabled && ((button.textContent ?? '').includes('Sign in') || button.type === 'submit'));
    const button = buttons[buttons.length - 1];
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 10_000, label: "sign-in submit" });
  ctx.assert(Boolean(submitted), "No sign-in submit button found.");
}

async function waitForOrganizationConsent(ctx) {
  // The consent page (/mcp/select-organization) renders the org radio list from
  // GET /api/den/v1/me/orgs. Wait for either the list (radios) or a terminal
  // state so we surface auth/empty problems instead of blindly hanging 60s.
  await ctx.waitFor(
    `(() => {
      const text = document.body.innerText;
      const radios = document.querySelectorAll('input[name="mcp-organization"], input[type="radio"]').length;
      const empty = text.includes("don't belong to any workspaces") || text.includes('Sign in before authorizing');
      return radios > 0 || empty;
    })()`,
    { timeoutMs: 60_000, label: "MCP organization consent list" },
  );
  const state = await ctx.eval(`(() => ({
    radios: document.querySelectorAll('input[name="mcp-organization"], input[type="radio"]').length,
    orgLabel: (document.querySelector('input[name="mcp-organization"]')?.closest('label')?.innerText || '').slice(0, 60),
    snippet: document.body.innerText.slice(0, 300),
  }))()`);
  ctx.recordEvidence({ type: "output", name: "Consent page state", text: JSON.stringify(state, null, 2) });
  ctx.assert(state.radios > 0, `Consent page did not list any organization. Page said: ${state.snippet}`);
}

async function selectAcmeOrganization(ctx) {
  // Prefer the Acme Robotics row; fall back to the first org radio so the flow
  // still proves the end-to-end token exchange on any seeded single-org owner.
  await ctx.waitFor(`(() => {
    const labels = [...document.querySelectorAll('label')];
    const acme = labels.find((l) => (l.textContent ?? '').includes('Acme Robotics'));
    const target = acme
      ?? document.querySelector('input[name="mcp-organization"]')?.closest('label')
      ?? document.querySelector('input[name="mcp-organization"]');
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    (target.querySelector?.('input') ?? target).click();
    return true;
  })()`, { timeoutMs: 20_000, label: "select organization radio" });
}

async function clickAuthorizeAndContinue(ctx) {
  const clicked = await ctx.waitFor(`(() => {
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => !button.disabled && /Authorize/i.test((button.textContent ?? '').trim()));
    const button = buttons[buttons.length - 1];
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return (button?.textContent ?? '').trim() || null;
  })()`, { timeoutMs: 20_000, label: "Authorize and continue button" });
  ctx.log(`Clicked OAuth consent button: ${clicked}`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setLoopbackPage(status, details) {
  loopbackPage = { status, details };
}

function renderLoopbackPage() {
  const details = loopbackPage.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenWork MCP client — ${escapeHtml(loopbackPage.status)}</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef7ff; color: #0f172a; }
      main { width: min(760px, calc(100vw - 48px)); border: 1px solid #bae6fd; border-radius: 28px; background: white; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.16); padding: 40px; }
      p { color: #475569; line-height: 1.6; }
      code { background: #e0f2fe; border-radius: 8px; padding: 2px 6px; }
      li { margin: 8px 0; }
    </style>
  </head>
  <body>
    <main>
      <p>OpenWork MCP client</p>
      <h1>OpenWork MCP client — ${escapeHtml(loopbackPage.status)}</h1>
      <p>Loopback redirect URI: <code>${escapeHtml(REDIRECT_URI)}</code></p>
      <ul>${details}</ul>
    </main>
  </body>
</html>`;
}

async function startLoopbackServer() {
  const serverUrl = `http://127.0.0.1:${REDIRECT_PORT}`;
  setLoopbackPage("waiting for authorization", ["OpenWork MCP client is waiting for the browser callback."]);
  let resolved = false;
  let resolveCode;
  let rejectCode;
  const waitForCode = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", serverUrl);
    if (requestUrl.pathname === "/callback") {
      const code = requestUrl.searchParams.get("code") ?? "";
      if (code) {
        setLoopbackPage("authorization code received", ["OpenWork redirected back to the loopback callback.", "The client can now exchange the code for tokens."]);
        if (!resolved) {
          resolved = true;
          resolveCode(code);
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderLoopbackPage());
        return;
      }
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>OpenWork MCP client — missing code</h1>");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderLoopbackPage());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    waitForCode,
    close: async () => {
      if (!resolved) {
        resolved = true;
        rejectCode(new Error("Loopback server closed before receiving an authorization code."));
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
    serverUrl,
  };
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function postUnauthenticatedInitialize() {
  const response = await fetch(`${apiBaseUrl()}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "initialize", params: initializeParams() }),
  });
  const { text, body } = await readResponseBody(response);
  const wwwAuthenticate = response.headers.get("www-authenticate") ?? "";
  return {
    status: response.status,
    wwwAuthenticate,
    resourceMetadataUrl: parseResourceMetadataChallenge(wwwAuthenticate),
    body,
    rawBody: text,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const { text, body } = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

async function registerOAuthClient(registrationEndpoint) {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CLIENT_SCOPE,
    }),
  });
  const { text, body } = await readResponseBody(response);
  return { status: response.status, ok: response.ok, body, rawBody: text };
}

function buildAuthorizeUrl() {
  const metadata = state.authorizationServerMetadata;
  const prm = state.protectedResourceMetadata;
  const clientId = readString(state.registration?.body, "client_id");
  const authorizationEndpoint = readString(metadata, "authorization_endpoint");
  const resource = readString(prm, "resource");
  state.pkce = createPkce();
  state.oauthState = crypto.randomBytes(16).toString("hex");

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", CLIENT_SCOPE);
  url.searchParams.set("state", state.oauthState);
  url.searchParams.set("code_challenge", state.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  return url.toString();
}

async function exchangeCodeForToken() {
  const metadata = state.authorizationServerMetadata;
  const prm = state.protectedResourceMetadata;
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", state.authorizationCode);
  form.set("redirect_uri", REDIRECT_URI);
  form.set("client_id", readString(state.registration?.body, "client_id"));
  form.set("code_verifier", state.pkce?.verifier ?? "");
  form.set("resource", readString(prm, "resource"));

  const response = await fetch(readString(metadata, "token_endpoint"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  const { text, body } = await readResponseBody(response);
  return { status: response.status, ok: response.ok, body, rawBody: text };
}

async function mcpCallTo(apiBase, path, mcpToken, method, params) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${method} (${path}) failed: ${response.status} ${raw.slice(0, 300)}`);
  }
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`MCP ${method} (${path}) returned no data frame: ${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(dataLine.slice(5));
  if (parsed.error) {
    throw new Error(`MCP ${method} (${path}) returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  }
  return { result: parsed.result, raw };
}

async function closeLoopback(ctx) {
  if (!state.loopback) return;
  const loopback = state.loopback;
  state.loopback = null;
  await loopback.close().catch((error) => {
    ctx.log(`Loopback close skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export default {
  id: FLOW_ID,
  title: "A URL-only MCP client connects to the API origin end to end",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove(vo[0], {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            state.unauthenticatedInitialize = await postUnauthenticatedInitialize();
            state.protectedResourceMetadataUrl = state.unauthenticatedInitialize.resourceMetadataUrl;
            ctx.output("WWW-Authenticate header", state.unauthenticatedInitialize.wwwAuthenticate);
            await navigateBrowser(ctx, protectedResourceMetadataBrowserUrl(), "API protected-resource metadata JSON");
            await ctx.waitForText("resource", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const actual = {
              status: state.unauthenticatedInitialize?.status,
              wwwAuthenticate: state.unauthenticatedInitialize?.wwwAuthenticate,
              resourceMetadataUrl: state.protectedResourceMetadataUrl,
              resourceMetadataOrigin: originOf(state.protectedResourceMetadataUrl),
              apiOrigin: originOf(apiBaseUrl()),
            };
            recordAssertion(
              ctx,
              "Unauthenticated MCP initialize returns 401 and advertises protected-resource metadata on the API origin",
              actual.status === 401 && actual.resourceMetadataOrigin === actual.apiOrigin,
              actual,
            );
          },
          screenshot: { name: "frame-1-api-protected-resource-json", requireText: ["resource"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove(vo[1], {
          voiceover: vo[1],
          action: async () => {
            state.protectedResourceMetadata = await fetchJson(state.protectedResourceMetadataUrl);
            const authorizationServers = Array.isArray(state.protectedResourceMetadata?.authorization_servers)
              ? state.protectedResourceMetadata.authorization_servers
              : [];
            const authorizationServer = typeof authorizationServers[0] === "string" ? authorizationServers[0] : "";
            state.authorizationServerMetadataUrl = `${authorizationServer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
            state.authorizationServerMetadata = await fetchJson(state.authorizationServerMetadataUrl);
            await navigateBrowser(ctx, state.authorizationServerMetadataUrl, "authorization server metadata JSON");
            await ctx.waitForText("authorization_endpoint", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const authorizationServers = Array.isArray(state.protectedResourceMetadata?.authorization_servers)
              ? state.protectedResourceMetadata.authorization_servers
              : [];
            const metadata = state.authorizationServerMetadata;
            const actual = {
              resource: state.protectedResourceMetadata?.resource,
              resourceOrigin: originOf(state.protectedResourceMetadata?.resource ?? ""),
              apiOrigin: originOf(apiBaseUrl()),
              authorizationServers,
              registrationEndpoint: readString(metadata, "registration_endpoint"),
              authorizationEndpoint: readString(metadata, "authorization_endpoint"),
              tokenEndpoint: readString(metadata, "token_endpoint"),
            };
            recordAssertion(
              ctx,
              "Protected-resource metadata declares the API origin as the resource and exposes an authorization server",
              actual.resourceOrigin === actual.apiOrigin && typeof authorizationServers[0] === "string" && authorizationServers[0].length > 0,
              actual,
            );
            recordAssertion(
              ctx,
              "Authorization-server metadata exposes registration, authorization, and token endpoints",
              Boolean(actual.registrationEndpoint && actual.authorizationEndpoint && actual.tokenEndpoint),
              actual,
            );
          },
          screenshot: { name: "frame-2-authorization-server-json", requireText: ["authorization_endpoint"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove(vo[2], {
          voiceover: vo[2],
          action: async () => {
            await closeLoopback(ctx);
            await clearDenWebSession(ctx);
            state.loopback = await startLoopbackServer();
            state.registration = await registerOAuthClient(readString(state.authorizationServerMetadata, "registration_endpoint"));
            state.authorizeUrl = buildAuthorizeUrl();
            await navigateBrowser(ctx, state.authorizeUrl, "OAuth authorize redirects to sign-in");
            await waitForSignInForm(ctx);
          },
          assert: async () => {
            const signInFields = await ctx.eval(`(() => ({
              hasEmail: Boolean(document.querySelector('input[type="email"], input[name="email"]')),
              hasPassword: Boolean(document.querySelector('input[type="password"]')),
              bodyText: document.body.innerText,
            }))()`);
            const actual = {
              registrationStatus: state.registration?.status,
              clientId: readString(state.registration?.body, "client_id"),
              authorizeUrl: state.authorizeUrl,
              signInFields,
            };
            recordAssertion(
              ctx,
              "Dynamic client registration returns a client_id for the loopback MCP client",
              state.registration?.ok === true && actual.clientId.length > 0,
              actual,
            );
            recordAssertion(
              ctx,
              "The authorize URL sends the browser to the real OpenWork sign-in page",
              signInFields?.hasEmail === true && signInFields?.hasPassword === true && signInFields?.bodyText?.includes("Sign in") === true,
              signInFields,
            );
          },
          screenshot: { name: "frame-3-openwork-sign-in", requireText: ["Sign in"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove(vo[3], {
          voiceover: vo[3],
          action: async () => {
            await submitSignIn(ctx);
            await waitForOrganizationConsent(ctx);
            await selectAcmeOrganization(ctx);
            // ctx.prove captures screenshots after assertions, but this frame's
            // meaningful UI is the consent page before the redirect fires.
            await ctx.screenshot("frame-4-workspace-consent-before-authorize", {
              claim: vo[3],
              voiceover: vo[3],
              requireText: ["CHOOSE WORKSPACE"],
            });
            await clickAuthorizeAndContinue(ctx);
          },
          assert: async () => {
            state.authorizationCode = await Promise.race([
              state.loopback.waitForCode,
              new Promise((resolve) => setTimeout(() => resolve(""), 30_000)),
            ]);
            recordAssertion(
              ctx,
              "The loopback callback resolves with a non-empty OAuth authorization code after Acme Robotics is approved",
              typeof state.authorizationCode === "string" && state.authorizationCode.length > 0,
              { codeLength: state.authorizationCode.length },
            );
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove(vo[4], {
          voiceover: vo[4],
          action: async () => {
            state.tokenExchange = await exchangeCodeForToken();
            state.accessToken = readString(state.tokenExchange?.body, "access_token");
            setLoopbackPage("connected", [
              "Token exchange completed against the discovered token endpoint.",
              `Access token accepted for resource ${readString(state.protectedResourceMetadata, "resource")}.`,
            ]);
            await navigateBrowser(ctx, state.loopback.serverUrl, "loopback connected page");
            await ctx.waitForText("connected", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const tokenParts = state.accessToken.split(".").length;
            const actual = {
              status: state.tokenExchange?.status,
              ok: state.tokenExchange?.ok,
              tokenType: readString(state.tokenExchange?.body, "token_type"),
              accessToken: redactToken(state.accessToken),
              tokenParts,
              errorBody: state.tokenExchange?.ok ? undefined : (state.tokenExchange?.rawBody ?? "").slice(0, 400),
            };
            ctx.recordEvidence({ type: "output", name: "Token exchange response", text: JSON.stringify(actual, null, 2) });
            recordAssertion(
              ctx,
              "The authorization code exchanges for a non-empty MCP access token with an accepted token shape",
              state.tokenExchange?.ok === true
                && state.accessToken.length > 0
                && (tokenParts === 3 || state.accessToken.startsWith("ow_mcp_at_")),
              actual,
            );
          },
          screenshot: { name: "frame-5-loopback-connected", requireText: ["connected"] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
          await ctx.prove(vo[5], {
            voiceover: vo[5],
            action: async () => {
              const initialize = await mcpCallTo(apiBaseUrl(), MCP_PATH, state.accessToken, "initialize", initializeParams());
              state.mcpInitializeResult = initialize.result;
              const tools = await mcpCallTo(apiBaseUrl(), MCP_PATH, state.accessToken, "tools/list", {});
              state.toolsListResult = tools.result;

              const search = await mcpCallTo(apiBaseUrl(), MCP_PATH, state.accessToken, "tools/call", {
                name: "search_capabilities",
                arguments: { query: "list organization" },
              });
              state.searchPayload = parseJsonText(readFirstText(search.result));

              const execute = await mcpCallTo(apiBaseUrl(), MCP_PATH, state.accessToken, "tools/call", {
                name: "execute_capability",
                arguments: { name: "getOrg" },
              });
              state.executePayload = parseJsonText(readFirstText(execute.result));
              state.organizationName = readString(state.executePayload?.organization, "name");

              const toolNames = (state.toolsListResult?.tools ?? []).map((tool) => tool.name).sort();
              setLoopbackPage("connected — tools ready", [
                `tools/list returned: ${toolNames.join(", ")}`,
                `search_capabilities found getOrg: ${Boolean((state.searchPayload?.matches ?? []).find((match) => match.name === "getOrg"))}`,
                `execute_capability returned organization: ${state.organizationName}`,
              ]);
              await navigateBrowser(ctx, state.loopback.serverUrl, "loopback tools page");
              await ctx.waitForText("search_capabilities", { timeoutMs: 30_000 });
            },
            assert: async () => {
              const toolNames = (state.toolsListResult?.tools ?? []).map((tool) => tool.name).sort();
              const matches = Array.isArray(state.searchPayload?.matches) ? state.searchPayload.matches : [];
              const hasGetOrg = matches.some((match) => match.name === "getOrg");
              const executeHasOrganizationName = state.organizationName.length > 0;

              ctx.recordEvidence({
                type: "output",
                name: "search_capabilities payload",
                text: JSON.stringify(state.searchPayload, null, 2),
              });
              ctx.recordEvidence({
                type: "output",
                name: "execute_capability payload",
                text: JSON.stringify(state.executePayload, null, 2),
              });

              recordAssertion(
                ctx,
                "Authenticated tools/list on the API-origin agent endpoint exposes exactly execute_capability and search_capabilities",
                JSON.stringify(toolNames) === JSON.stringify(EXPECTED_AGENT_TOOLS),
                { tools: toolNames, initializeResult: state.mcpInitializeResult },
              );
              recordAssertion(
                ctx,
                "search_capabilities finds getOrg and execute_capability returns organization data",
                hasGetOrg && executeHasOrganizationName,
                { matches, organizationName: state.organizationName, executePayload: state.executePayload },
              );
            },
            screenshot: { name: "frame-6-loopback-tools", requireText: ["search_capabilities"] },
          });
        } finally {
          await closeLoopback(ctx);
        }
      },
    },
  ],
};
