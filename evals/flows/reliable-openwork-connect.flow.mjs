import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { denApiUrl, denWebUrl } from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "reliable-openwork-connect";
const MCP_NAME = "openwork";
const MCP_PATH = "/mcp/agent";
const PUBLIC_MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
const CLIENT_SCOPE = "mcp:read mcp:write offline_access";
const CLIENT_NAME = "OpenWork reliable connect eval client";
const OPENCODE_BIN = process.env.OPENWORK_EVAL_OPENCODE_BIN?.trim() || "opencode";
const DEMO_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const DEMO_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const SECTION_SELECTOR = "#connect-mcp";
const INSTALL_SELECTOR = "#connect-mcp-install";
const ACTIVE_PANEL_SELECTOR = `${INSTALL_SELECTOR} [role="tabpanel"]:not([hidden])`;
const EXPECTED_TOOLS = ["execute_capability", "search_capabilities"];
const OPENCODE_AUTH_COMMAND = "opencode mcp auth openwork";
const OPENCODE_RECONNECT_COMMAND = `opencode mcp logout openwork
opencode mcp auth openwork`;
const CODEX_COMMAND = `codex mcp add openwork --url ${PUBLIC_MCP_SERVER_URL}`;
const CODEX_LOGIN_COMMAND = "codex mcp login openwork";
const CODEX_RECONNECT_COMMAND = `codex mcp logout openwork
codex mcp login openwork`;
const CLIENT_EXPECTATIONS = [
  {
    label: "Cursor",
    status: "Setup only",
    oauthNeedles: ["Cursor Web/Agents", "cursor://anysphere.cursor-mcp/oauth/callback"],
  },
  {
    label: "Codex",
    status: "Setup only",
    oauthNeedles: ["Codex's MCP login command", CODEX_LOGIN_COMMAND, "Native proof must be rerun on this exact branch"],
  },
  {
    label: "ChatGPT Desktop",
    status: "Setup only",
    oauthNeedles: ["Settings > MCP servers", "Native proof is not complete"],
  },
  {
    label: "Claude Code",
    status: "Setup only",
    oauthNeedles: ["use /mcp in Claude Code", "Native proof is not complete"],
  },
  {
    label: "OpenCode",
    status: "Verified",
    oauthNeedles: ["OpenCode config", OPENCODE_AUTH_COMMAND, "OpenCode native remote MCP OAuth"],
  },
  {
    label: "VS Code",
    status: "Setup only",
    oauthNeedles: ["start OAuth from VS Code's MCP server prompt", "Native proof is not complete"],
  },
  {
    label: "Any client",
    status: "Setup only",
    oauthNeedles: ["remote Streamable HTTP", "OAuth", "Native proof depends on the client"],
  },
];

// Narration is loaded from the approved script (evals/voiceovers/reliable-openwork-connect.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const state = {
  landingVisiblePanels: null,
  installVisiblePanels: null,
  unauthenticatedInitialize: null,
  protectedResourceMetadataUrl: "",
  protectedResourceMetadata: null,
  authorizationServerMetadataUrl: "",
  authorizationServerMetadata: null,
  registration: null,
  redirectUri: "",
  pkce: null,
  oauthState: "",
  authorizeUrl: "",
  selectedOrganizationLabel: "",
  loopback: null,
  callback: null,
  authorizationCode: "",
  tokenExchange: null,
  firstAccessToken: "",
  firstRefreshToken: "",
  firstRefresh: null,
  secondRefresh: null,
  currentAccessToken: "",
  concurrentRefreshToken: "",
  mcpInitialize: null,
  toolsList: null,
  searchPayload: null,
  executePayload: null,
  refreshedToolsList: null,
  refreshedExecutePayload: null,
  organizationName: "",
  nativeRunId: crypto.randomBytes(6).toString("hex"),
  nativeTempRoot: "",
  nativeEnv: null,
  nativeConfigPath: "",
  nativeAuthFilePath: "",
  nativeBrowserCaptureEndpoint: "",
  nativeBrowserCaptureServer: null,
  nativeCapturedBrowserUrls: [],
  nativeBrowserCaptureSummaries: [],
  nativeBrowserCaptureScript: "",
  nativeBrowserCaptureBinDir: "",
  nativeAuthChild: null,
  nativeAuthResult: null,
  nativeAuthStdoutChunks: null,
  nativeAuthStderrChunks: null,
  nativeAuthorizeUrl: "",
  nativeRedirectUri: "",
  nativeClientId: "",
  nativeCredentialBeforeRefresh: null,
  nativeCredentialAfterRefresh: null,
  nativeAuthList: null,
  nativeMcpListBeforeRefresh: null,
  nativeMcpListAfterRefresh: null,
  nativeCleanup: null,
  expiredSession: null,
  revokedSessionResponse: null,
  rateLimitAttempts: 0,
  frame4Proof: null,
  frame4ReportServer: null,
  frame5Matrix: null,
  frame5ReportServer: null,
};

let nativeSyncCleanupRegistered = false;
let nativeAuthExitPromise = null;

function apiBaseUrl() {
  return denApiUrl();
}

function webBaseUrl() {
  return denWebUrl();
}

function mcpServerUrl() {
  return `${apiBaseUrl()}${MCP_PATH}`;
}

function baseUrlFromEnv(ctx, name) {
  return ctx.env[name].trim().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value, key) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function readNumber(value, key) {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : null;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function shortHash(value) {
  return hashText(value).slice(0, 12);
}

function queryValueSummary(value) {
  const text = String(value ?? "");
  return {
    present: text.length > 0,
    length: text.length,
    hash: text.length > 0 ? shortHash(text) : "",
  };
}

function summarizeUrlForEvidence(value) {
  try {
    const url = new URL(value);
    const queryEntries = Array.from(url.searchParams.entries()).map(([name, entry]) => ({
      name,
      valueLength: entry.length,
      valueHash: entry.length > 0 ? shortHash(entry) : "",
    })).sort((left, right) => left.name.localeCompare(right.name) || left.valueHash.localeCompare(right.valueHash));
    return {
      origin: url.origin,
      pathname: url.pathname,
      queryParamNames: Array.from(new Set(Array.from(url.searchParams.keys()))).sort(),
      queryParamCount: queryEntries.length,
      queryEntries,
      hashPresent: url.hash.length > 0,
      hashLength: url.hash.length,
      hashHash: url.hash.length > 0 ? shortHash(url.hash) : "",
    };
  } catch {
    return { valid: false, length: String(value ?? "").length, hash: shortHash(value ?? "") };
  }
}

function sensitiveOAuthUrlSummary(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const sensitiveParam = Array.from(url.searchParams.keys()).some((key) => /(^code$|state|challenge|verifier|token|secret|consent|signature|signed)/i.test(key));
    const sensitivePath = /\/oauth2\/(?:authorize|consent|token|register)|\/callback$/i.test(url.pathname);
    if (!sensitiveParam && !(sensitivePath && url.search.length > 0)) return null;
    return { redacted: "sensitive-oauth-url", ...summarizeUrlForEvidence(value) };
  } catch {
    return null;
  }
}

function tokenPrefix(token) {
  if (token.startsWith("ow_mcp_at_")) return "ow_mcp_at_";
  if (token.startsWith("ow_mcp_rt_")) return "ow_mcp_rt_";
  return token.includes(".") ? "jwt" : "opaque";
}

function tokenShape(token) {
  return {
    present: typeof token === "string" && token.length > 0,
    prefix: typeof token === "string" && token.length > 0 ? tokenPrefix(token) : "",
    opaque: typeof token === "string" && token.length > 0 && !token.includes("."),
    jwt: typeof token === "string" && token.split(".").length === 3,
    fingerprint: typeof token === "string" && token.length > 0 ? hashText(token).slice(0, 12) : "",
  };
}

function looksLikeUnredactedToken(value) {
  return /(?:Bearer\s+)?ow_mcp_(?:at|rt)_[A-Za-z0-9_-]{24,}|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b|"(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken)"\s*:\s*"[^"]{20,}"|(?:authorization|bearer|token)[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9._-]{40,}/i.test(String(value));
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (!isRecord(value)) {
    if (typeof value === "string") {
      const sensitiveUrl = sensitiveOAuthUrlSummary(value);
      if (sensitiveUrl) return sensitiveUrl;
      if (looksLikeUnredactedToken(value)) return "[redacted-token]";
    }
    return value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|authorization|code_verifier|code_challenge|oauthState|^state$|^code$/i.test(key)) {
      output[key] = typeof entry === "string" && entry.length > 0 ? "[redacted]" : sanitizeValue(entry);
    } else {
      output[key] = sanitizeValue(entry);
    }
  }
  return output;
}

function bodyReference(body) {
  if (isRecord(body)) {
    const direct = readString(body, "referenceId") || readString(body, "reference_id");
    if (direct) return direct;
    if (isRecord(body.error) && isRecord(body.error.data)) {
      const nested = readString(body.error.data, "referenceId") || readString(body.error.data, "reference_id");
      if (nested) return nested;
    }
  }
  return "";
}

function recordAssertion(ctx, assertion, passed, actual) {
  const safeActual = sanitizeValue(actual);
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual: JSON.stringify(safeActual),
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(safeActual)}`);
}

function initializeParams() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
  };
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationServerMetadataUrl(issuer) {
  const url = new URL(issuer);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${pathname}`;
}

function protectedResourceMetadataUrl(resource) {
  const url = new URL(resource);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${pathname}`;
}

function nativeAuthFileCandidates() {
  if (!state.nativeEnv) return [];
  return [
    path.join(state.nativeEnv.XDG_DATA_HOME, "opencode", "mcp-auth.json"),
    path.join(state.nativeEnv.XDG_CONFIG_HOME, "opencode", "mcp-auth.json"),
    path.join(state.nativeEnv.HOME, ".local", "share", "opencode", "mcp-auth.json"),
    path.join(state.nativeEnv.HOME, ".config", "opencode", "mcp-auth.json"),
  ];
}

function resolveNativeAuthFilePath() {
  const found = nativeAuthFileCandidates().find((candidate) => existsSync(candidate));
  return found ?? state.nativeAuthFilePath;
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) return;
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`));
}

async function navigateBrowser(ctx, url, label) {
  if (ctx.client?.send) {
    await ctx.client.send("Page.navigate", { url });
  } else {
    await ctx.eval(`(() => { window.location.href = ${JSON.stringify(url)}; return true; })()`);
  }
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label });
}

async function ensureLandingConnect(ctx) {
  const url = `${baseUrlFromEnv(ctx, "OPENWORK_EVAL_LANDING_URL")}/#connect-mcp`;
  await applyDesktopViewport(ctx);
  await navigateBrowser(ctx, url, "landing OpenWork Connect section");
  await ctx.waitFor(
    `(() => {
      const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
      const text = section ? section.innerText : "";
      return location.href === ${JSON.stringify(url)}
        && Boolean(section)
        && text.includes(${JSON.stringify(PUBLIC_MCP_SERVER_URL)})
        && text.includes("Verified for OpenCode only");
    })()`,
    { timeoutMs: 30_000, label: "landing Connect MCP installer" },
  );
  await ctx.eval(`document.querySelector(${JSON.stringify(INSTALL_SELECTOR)})?.scrollIntoView({ block: "start", behavior: "instant" }); true`);
  return url;
}

function tabExpression(label) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(`${INSTALL_SELECTOR} [role="tab"]`)}))
    .find((tab) => (tab.textContent || "").trim() === ${JSON.stringify(label)})`;
}

async function realMouseClick(ctx, elementExpression, label) {
  const point = await ctx.eval(`(() => {
    const element = ${elementExpression};
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);
  ctx.assert(point !== null && point.visible === true, `${label} was not visible for a real click.`);

  if (!ctx.client?.send) {
    await ctx.eval(`(() => { const element = ${elementExpression}; element?.click(); return true; })()`);
    return;
  }

  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function clickClientTab(ctx, label) {
  await realMouseClick(ctx, tabExpression(label), `${label} client tab`);
  await ctx.waitFor(
    `(() => {
      const selected = document.querySelector(${JSON.stringify(`${INSTALL_SELECTOR} [role="tab"][aria-selected="true"]`)});
      return (selected?.textContent || "").trim() === ${JSON.stringify(label)};
    })()`,
    { timeoutMs: 10_000, label: `${label} tab selected` },
  );
}

async function visiblePanelSnapshot(ctx) {
  return ctx.eval(`(() => {
    const panel = document.querySelector(${JSON.stringify(ACTIVE_PANEL_SELECTOR)});
    const selected = document.querySelector(${JSON.stringify(`${INSTALL_SELECTOR} [role="tab"][aria-selected="true"]`)});
    const text = panel ? panel.innerText : "";
    return {
      panelId: panel?.id || "",
      selected: (selected?.textContent || "").trim(),
      status: panel?.getAttribute("data-support-status") || "",
      text,
      hidden: panel?.hidden ?? true,
    };
  })()`);
}

async function collectVisibleClientPanels(ctx) {
  const panels = {};
  for (const client of CLIENT_EXPECTATIONS) {
    await clickClientTab(ctx, client.label);
    const snapshot = await visiblePanelSnapshot(ctx);
    panels[client.label] = {
      selected: snapshot.selected,
      panelId: snapshot.panelId,
      status: snapshot.status,
      statusVisible: snapshot.status.length > 0 && snapshot.text.toLowerCase().includes(snapshot.status.toLowerCase()),
      hidden: snapshot.hidden,
      hasServerUrl: snapshot.text.includes(PUBLIC_MCP_SERVER_URL),
      text: snapshot.text,
    };
  }
  return panels;
}

function visibleStatusSummary(panels) {
  return Object.fromEntries(Object.entries(panels).map(([label, panel]) => [label, {
    selected: panel.selected,
    status: panel.status,
    statusVisible: panel.statusVisible,
    hidden: panel.hidden,
    hasServerUrl: panel.hasServerUrl,
  }]));
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: text };
  }
}

async function captureHttpResponse(label, response) {
  const { text, body } = await readResponseBody(response);
  const requestId = response.headers.get("x-request-id") ?? "";
  const wwwAuthenticate = response.headers.get("www-authenticate") ?? "";
  const retryAfter = response.headers.get("retry-after") ?? "";
  const contentType = response.headers.get("content-type") ?? "";
  return {
    label,
    status: response.status,
    ok: response.ok,
    requestId,
    contentType,
    wwwAuthenticate,
    retryAfter,
    body: sanitizeValue(body),
    bodyReference: bodyReference(body),
    rawBodyHash: hashText(text).slice(0, 12),
  };
}

function parseResourceMetadataChallenge(header) {
  const match = header.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i);
  return match?.[1] ?? match?.[2] ?? "";
}

async function postUnauthenticatedInitialize() {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "initialize", params: initializeParams() }),
  });
  const captured = await captureHttpResponse("missing bearer discovery", response);
  captured.resourceMetadataUrl = parseResourceMetadataChallenge(captured.wwwAuthenticate);
  return captured;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const { text, body } = await readResponseBody(response);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

async function registerOAuthClient(registrationEndpoint) {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [state.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CLIENT_SCOPE,
    }),
  });
  const { text, body } = await readResponseBody(response);
  return {
    status: response.status,
    ok: response.ok,
    requestId: response.headers.get("x-request-id") ?? "",
    body,
    errorBody: response.ok ? null : text.slice(0, 400),
  };
}

function buildAuthorizeUrl() {
  const authorizationEndpoint = readString(state.authorizationServerMetadata, "authorization_endpoint");
  const clientId = readString(state.registration?.body, "client_id");
  const resource = readString(state.protectedResourceMetadata, "resource");
  state.pkce = createPkce();
  state.oauthState = crypto.randomBytes(16).toString("hex");
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", state.redirectUri);
  url.searchParams.set("scope", CLIENT_SCOPE);
  url.searchParams.set("state", state.oauthState);
  url.searchParams.set("code_challenge", state.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLoopbackPage(input) {
  const details = input.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenWork MCP client - ${escapeHtml(input.status)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f0f9ff; color: #0f172a; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      main { width: min(760px, calc(100vw - 48px)); border: 1px solid #bae6fd; border-radius: 28px; background: white; box-shadow: 0 24px 80px rgba(15,23,42,.16); padding: 40px; }
      p { color: #475569; line-height: 1.6; }
      code { background: #e0f2fe; border-radius: 8px; padding: 2px 6px; }
      li { margin: 8px 0; }
    </style>
  </head>
  <body>
    <main>
      <p>OpenWork MCP client</p>
      <h1>${escapeHtml(input.status)}</h1>
      <p>Loopback redirect URI: <code>${escapeHtml(input.redirectUri)}</code></p>
      <ul>${details}</ul>
    </main>
  </body>
</html>`;
}

async function startLoopbackServer() {
  let status = "waiting for authorization";
  let details = ["The browser is authorizing OpenWork MCP access."];
  let resolveCallback;
  const waitForCallback = new Promise((resolve) => {
    resolveCallback = resolve;
  });

  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const requestUrl = new URL(request.url ?? "/", base);
    if (requestUrl.pathname === "/callback") {
      const callbackState = requestUrl.searchParams.get("state") ?? "";
      status = requestUrl.searchParams.get("code") ? "authorization code received" : "callback missing authorization code";
      details = [
        "OpenWork redirected back to the client loopback callback.",
        "The callback carried an authorization code and state only; no bearer or refresh tokens are present in the URL.",
      ];
      resolveCallback({
        url: summarizeUrlForEvidence(requestUrl.toString()),
        codeLength: (requestUrl.searchParams.get("code") ?? "").length,
        stateHash: callbackState ? shortHash(callbackState) : "",
        hasAccessToken: requestUrl.searchParams.has("access_token"),
        hasRefreshToken: requestUrl.searchParams.has("refresh_token"),
        hasIdToken: requestUrl.searchParams.has("id_token"),
        hasTokenType: requestUrl.searchParams.has("token_type"),
      });
      response.writeHead(requestUrl.searchParams.get("code") ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      response.end(renderLoopbackPage({ status, details, redirectUri: `${base}/callback` }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderLoopbackPage({ status, details, redirectUri: `${base}/callback` }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const port = server.address().port;
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCallback,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function closeLoopback(ctx) {
  if (!state.loopback) return;
  const loopback = state.loopback;
  state.loopback = null;
  await loopback.close().catch((error) => ctx.log(`Loopback cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
}

async function startNativeBrowserCaptureServer() {
  if (state.nativeBrowserCaptureServer) return;
  const capturePath = `/${crypto.randomBytes(12).toString("hex")}`;
  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const requestUrl = new URL(request.url ?? "/", base);
    if (request.method !== "POST" || requestUrl.pathname !== capturePath) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(Buffer.from(chunk));
      if (size > 64 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const captured = readString(parsed, "url");
        if (captured) {
          state.nativeCapturedBrowserUrls.push(captured);
          state.nativeBrowserCaptureSummaries.push({
            launcher: readString(parsed, "launcher"),
            capturedAt: readString(parsed, "capturedAt"),
            argumentCount: readNumber(parsed, "argumentCount"),
            url: summarizeUrlForEvidence(captured),
          });
        }
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  state.nativeBrowserCaptureServer = server;
  state.nativeBrowserCaptureEndpoint = `http://127.0.0.1:${server.address().port}${capturePath}`;
}

async function closeNativeBrowserCaptureServer(ctx) {
  const server = state.nativeBrowserCaptureServer;
  if (!server) return;
  state.nativeBrowserCaptureServer = null;
  state.nativeBrowserCaptureEndpoint = "";
  await new Promise((resolve) => server.close(() => resolve()))
    .catch((error) => ctx.log(`Browser capture server cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
}

function registerNativeSyncCleanup() {
  if (nativeSyncCleanupRegistered) return;
  nativeSyncCleanupRegistered = true;
  process.once("exit", () => {
    if (state.nativeTempRoot) {
      rmSync(state.nativeTempRoot, { recursive: true, force: true });
    }
  });
}

async function prepareNativeOpenCodeEnvironment() {
  if (state.nativeTempRoot) return;
  await startNativeBrowserCaptureServer();
  const root = await mkdtemp(path.join(os.tmpdir(), `openwork-reliable-connect-${state.nativeRunId}-`));
  const xdgConfigHome = path.join(root, "xdg-config");
  const xdgDataHome = path.join(root, "xdg-data");
  const xdgCacheHome = path.join(root, "xdg-cache");
  const home = path.join(root, "home");
  const captureBinDir = path.join(root, "bin");
  const configDir = path.join(xdgConfigHome, "opencode");
  const dataDir = path.join(xdgDataHome, "opencode");
  const cacheDir = path.join(xdgCacheHome, "opencode");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(captureBinDir, { recursive: true }),
  ]);

  state.nativeTempRoot = root;
  state.nativeConfigPath = path.join(configDir, "opencode.json");
  state.nativeAuthFilePath = path.join(dataDir, "mcp-auth.json");
  state.nativeBrowserCaptureScript = path.join(root, "capture-browser.js");
  state.nativeBrowserCaptureBinDir = captureBinDir;
  state.nativeEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_CACHE_HOME: xdgCacheHome,
    PATH: [captureBinDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    BROWSER: state.nativeBrowserCaptureScript,
    OPENWORK_EVAL_BROWSER_CAPTURE_ENDPOINT: state.nativeBrowserCaptureEndpoint,
    NO_COLOR: "1",
  };

  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [MCP_NAME]: {
        type: "remote",
        url: mcpServerUrl(),
        enabled: true,
        oauth: {},
      },
    },
  };
  const browserCaptureScript = `#!/usr/bin/env node
const http = require("node:http");
const endpoint = process.env.OPENWORK_EVAL_BROWSER_CAPTURE_ENDPOINT || "";
const launcher = process.env.OPENWORK_EVAL_BROWSER_LAUNCHER || "BROWSER";
const argv = process.argv.slice(2);
function unquote(value) {
  let output = String(value || "").trim();
  let changed = true;
  while (changed && output.length >= 2) {
    changed = false;
    const first = output[0];
    const last = output[output.length - 1];
    if ((first === "\\\"" && last === "\\\"") || (first === "'" && last === "'")) {
      output = output.slice(1, -1).trim();
      changed = true;
    }
  }
  return output;
}
function capturedUrl(value) {
  const match = unquote(value).match(/https?:\\/\\/[^\\s\"'<>]+/);
  if (!match) return "";
  let candidate = match[0];
  while (/[),.;\\]]$/.test(candidate)) candidate = candidate.slice(0, -1);
  try {
    return new URL(candidate).toString();
  } catch {
    return "";
  }
}
const url = argv.map(capturedUrl).find(Boolean) || "";
function finish() {
  process.exit(0);
}
if (!endpoint || !url) finish();
try {
  const target = new URL(endpoint);
  const body = JSON.stringify({ url, launcher, capturedAt: new Date().toISOString(), argumentCount: argv.length });
  const request = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    timeout: 2000,
  }, (response) => {
    response.resume();
    response.on("end", finish);
  });
  request.on("timeout", () => request.destroy());
  request.on("error", finish);
  request.end(body);
} catch {
  finish();
}
`;
  const browserLauncherNames = [
    "open",
    "xdg-open",
    "sensible-browser",
    "x-www-browser",
    "www-browser",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "firefox",
    "brave",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "msedge",
    "vivaldi",
    "opera",
    "safari",
  ];
  const browserShimScript = (launcherName) => `#!/bin/sh
OPENWORK_EVAL_BROWSER_LAUNCHER=${JSON.stringify(launcherName)} exec ${JSON.stringify(state.nativeBrowserCaptureScript)} "$@"
`;
  await Promise.all([
    writeFile(state.nativeConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
    writeFile(state.nativeBrowserCaptureScript, browserCaptureScript, "utf8"),
    ...browserLauncherNames.map((launcherName) => writeFile(path.join(captureBinDir, launcherName), browserShimScript(launcherName), "utf8")),
  ]);
  await Promise.all([
    chmod(state.nativeBrowserCaptureScript, 0o755),
    ...browserLauncherNames.map((launcherName) => chmod(path.join(captureBinDir, launcherName), 0o755)),
  ]);
  registerNativeSyncCleanup();
}

function nativeCommandEnv() {
  if (!state.nativeEnv) throw new Error("Native OpenCode environment was not prepared.");
  return state.nativeEnv;
}

function collectNativeOutput(stream, chunks) {
  stream.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
}

function commandOutputText(chunks) {
  return Buffer.concat(chunks).toString("utf8");
}

function summarizeCommandResult(result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    label: result.label,
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal ?? "",
    stdoutHash: shortHash(result.stdout),
    stderrHash: shortHash(result.stderr),
    outputBytes: Buffer.byteLength(combined),
    mentionsOpenwork: /\bopenwork\b/i.test(combined),
    mentionsOAuth: /oauth|auth/i.test(combined),
    mentionsAuthenticated: /authenticated|authorized|logged\s*in|valid/i.test(combined),
    mentionsConnected: /connected|enabled|ready|remote/i.test(combined),
    containsUnredactedToken: looksLikeUnredactedToken(combined),
  };
}

async function runNativeOpenCode(args, label, timeoutMs = 45_000) {
  await prepareNativeOpenCodeEnvironment();
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(OPENCODE_BIN, args, {
    cwd: state.nativeTempRoot,
    env: nativeCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  collectNativeOutput(child.stdout, stdoutChunks);
  collectNativeOutput(child.stderr, stderrChunks);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        label,
        command: `${OPENCODE_BIN} ${args.join(" ")}`,
        exitCode: null,
        signal: "error",
        stdout: commandOutputText(stdoutChunks),
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        label,
        command: `${OPENCODE_BIN} ${args.join(" ")}`,
        exitCode: code,
        signal,
        stdout: commandOutputText(stdoutChunks),
        stderr: commandOutputText(stderrChunks),
      });
    });
  });
}

async function startNativeAuthProcess() {
  await prepareNativeOpenCodeEnvironment();
  const stdoutChunks = [];
  const stderrChunks = [];
  state.nativeAuthResult = null;
  state.nativeAuthStdoutChunks = stdoutChunks;
  state.nativeAuthStderrChunks = stderrChunks;
  const child = spawn(OPENCODE_BIN, ["mcp", "auth", MCP_NAME], {
    cwd: state.nativeTempRoot,
    env: nativeCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.nativeAuthChild = child;
  collectNativeOutput(child.stdout, stdoutChunks);
  collectNativeOutput(child.stderr, stderrChunks);
  nativeAuthExitPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      const result = {
        label: "opencode mcp auth",
        command: `${OPENCODE_BIN} mcp auth ${MCP_NAME}`,
        exitCode: null,
        signal: "error",
        stdout: commandOutputText(stdoutChunks),
        stderr: error instanceof Error ? error.message : String(error),
      };
      state.nativeAuthResult = result;
      state.nativeAuthChild = null;
      resolve(result);
    });
    child.once("close", (code, signal) => {
      const result = {
        label: "opencode mcp auth",
        command: `${OPENCODE_BIN} mcp auth ${MCP_NAME}`,
        exitCode: code,
        signal,
        stdout: commandOutputText(stdoutChunks),
        stderr: commandOutputText(stderrChunks),
      };
      state.nativeAuthResult = result;
      state.nativeAuthChild = null;
      resolve(result);
    });
  });
  return child;
}

async function killNativeAuthProcess(ctx) {
  const child = state.nativeAuthChild;
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([nativeAuthExitPromise, sleep(2_500)]).catch((error) => ctx.log(`Native auth process cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
  if (state.nativeAuthChild && !state.nativeAuthChild.killed) state.nativeAuthChild.kill("SIGKILL");
}

async function readCapturedAuthorizeUrl() {
  for (const url of state.nativeCapturedBrowserUrls.slice().reverse()) {
    if (isNativeAuthorizeUrl(url)) return url;
  }
  return "";
}

function normalizeUrlCandidate(value) {
  let candidate = String(value || "").trim();
  let changed = true;
  while (changed && candidate.length >= 2) {
    changed = false;
    const first = candidate[0];
    const last = candidate[candidate.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "<" && last === ">")) {
      candidate = candidate.slice(1, -1).trim();
      changed = true;
    }
  }
  while (/[),.;\]]$/.test(candidate)) candidate = candidate.slice(0, -1);
  return candidate;
}

function isNativeAuthorizeUrl(value) {
  try {
    const authorizationEndpoint = readString(state.authorizationServerMetadata, "authorization_endpoint");
    if (!authorizationEndpoint) return false;
    const candidate = new URL(normalizeUrlCandidate(value));
    const endpoint = new URL(authorizationEndpoint);
    const redirectUri = candidate.searchParams.get("redirect_uri") ?? "";
    return ["http:", "https:"].includes(candidate.protocol)
      && candidate.origin === endpoint.origin
      && candidate.pathname === endpoint.pathname
      && candidate.searchParams.get("response_type") === "code"
      && (candidate.searchParams.get("client_id") ?? "").length > 0
      && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(redirectUri)
      && (candidate.searchParams.get("state") ?? "").length > 10
      && (candidate.searchParams.get("code_challenge") ?? "").length > 20
      && candidate.searchParams.get("code_challenge_method") === "S256"
      && candidate.searchParams.get("resource") === mcpServerUrl();
  } catch {
    return false;
  }
}

function extractPrintedAuthorizeUrl(text) {
  const withoutAnsi = String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = withoutAnsi.match(/https?:\/\/[^\s"'<>\x1B]+/g) ?? [];
  for (const match of matches) {
    const candidate = normalizeUrlCandidate(match);
    if (isNativeAuthorizeUrl(candidate)) return candidate;
  }
  return "";
}

function nativeAuthOutputText() {
  const stdout = state.nativeAuthStdoutChunks ? commandOutputText(state.nativeAuthStdoutChunks) : state.nativeAuthResult?.stdout ?? "";
  const stderr = state.nativeAuthStderrChunks ? commandOutputText(state.nativeAuthStderrChunks) : state.nativeAuthResult?.stderr ?? "";
  return `${stdout}\n${stderr}`;
}

function readPrintedAuthorizeUrl() {
  return extractPrintedAuthorizeUrl(nativeAuthOutputText());
}

function authorizeUrlEvidenceSummary(value) {
  try {
    const url = new URL(value);
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    return {
      ...summarizeUrlForEvidence(value),
      responseTypeIsCode: url.searchParams.get("response_type") === "code",
      clientId: queryValueSummary(url.searchParams.get("client_id") ?? ""),
      redirectUri: queryValueSummary(redirectUri),
      redirectUriIsLoopback: /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(redirectUri),
      resource: queryValueSummary(url.searchParams.get("resource") ?? ""),
      scope: queryValueSummary(url.searchParams.get("scope") ?? ""),
      state: queryValueSummary(url.searchParams.get("state") ?? ""),
      codeChallenge: queryValueSummary(url.searchParams.get("code_challenge") ?? ""),
      codeChallengeMethodIsS256: url.searchParams.get("code_challenge_method") === "S256",
    };
  } catch {
    return { valid: false };
  }
}

async function waitForCapturedAuthorizeUrl(ctx) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const url = await readCapturedAuthorizeUrl();
    if (url) return url;
    const printedUrl = readPrintedAuthorizeUrl();
    if (printedUrl) return printedUrl;
    if (state.nativeAuthResult) {
      const summary = summarizeCommandResult(state.nativeAuthResult);
      throw new Error(`Native OpenCode auth exited before opening an authorize URL: ${JSON.stringify(summary)}`);
    }
    await sleep(250);
  }
  const printedUrl = readPrintedAuthorizeUrl();
  if (printedUrl) return printedUrl;
  await killNativeAuthProcess(ctx);
  throw new Error("Native OpenCode auth did not invoke the BROWSER capture executable within 60 seconds.");
}

async function waitForNativeAuthExit(ctx) {
  const result = await Promise.race([
    nativeAuthExitPromise,
    sleep(60_000).then(() => null),
  ]);
  if (result) return result;
  await killNativeAuthProcess(ctx);
  throw new Error("Native OpenCode auth did not exit after the loopback callback.");
}

function readCaseInsensitive(record, names) {
  if (!isRecord(record)) return undefined;
  const wanted = names.map((name) => name.toLowerCase());
  for (const [key, value] of Object.entries(record)) {
    if (wanted.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

function findStringDeep(value, names, depth = 0) {
  if (depth > 8 || !isRecord(value)) return "";
  const direct = readCaseInsensitive(value, names);
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const entry of Object.values(value)) {
    const found = findStringDeep(entry, names, depth + 1);
    if (found) return found;
  }
  return "";
}

function findValueDeep(value, names, depth = 0) {
  if (depth > 8 || !isRecord(value)) return undefined;
  const direct = readCaseInsensitive(value, names);
  if (direct !== undefined) return direct;
  for (const entry of Object.values(value)) {
    const found = findValueDeep(entry, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findServerCredential(value, depth = 0) {
  if (depth > 6 || !isRecord(value)) return null;
  const direct = value[MCP_NAME];
  if (isRecord(direct)) return direct;
  if (findStringDeep(value, ["accessToken", "access_token"], 0) && findStringDeep(value, ["refreshToken", "refresh_token"], 0)) return value;
  for (const entry of Object.values(value)) {
    const found = findServerCredential(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function nativeCredentialSummary(credential) {
  return {
    authFileHash: shortHash(state.nativeAuthFilePath),
    accessToken: tokenShape(credential.accessToken),
    refreshToken: tokenShape(credential.refreshToken),
    expiresAtPresent: credential.expiresAt !== undefined && credential.expiresAt !== null && String(credential.expiresAt).length > 0,
    clientIdPresent: credential.clientId.length > 0,
    clientIdHash: credential.clientId ? shortHash(credential.clientId) : "",
    clientMetadataPresent: credential.clientMetadataPresent,
  };
}

function extractNativeCredential(parsed) {
  const credential = findServerCredential(parsed);
  if (!credential) {
    return {
      credential: null,
      accessToken: "",
      refreshToken: "",
      expiresAt: undefined,
      clientId: "",
      clientMetadataPresent: false,
    };
  }
  const accessToken = findStringDeep(credential, ["accessToken", "access_token"]);
  const refreshToken = findStringDeep(credential, ["refreshToken", "refresh_token"]);
  const expiresAt = findValueDeep(credential, ["expiresAt", "expires_at", "expiry", "expires"]);
  const clientId = findStringDeep(credential, ["clientId", "client_id"]);
  const clientMetadata = readCaseInsensitive(credential, ["client", "clientInfo", "clientInformation", "clientMetadata"]);
  return {
    credential,
    accessToken,
    refreshToken,
    expiresAt,
    clientId,
    clientMetadataPresent: isRecord(clientMetadata) || clientId.length > 0,
  };
}

async function readNativeAuthJson() {
  state.nativeAuthFilePath = resolveNativeAuthFilePath();
  const raw = await readFile(state.nativeAuthFilePath, "utf8");
  return JSON.parse(raw);
}

async function readNativeCredential() {
  const parsed = await readNativeAuthJson();
  return { parsed, ...extractNativeCredential(parsed) };
}

function pastExpiryValue(current) {
  if (typeof current === "number") {
    if (current > 1_000_000_000_000) return Date.now() - 60_000;
    if (current > 1_000_000_000) return Math.floor(Date.now() / 1000) - 60;
    return 0;
  }
  if (typeof current === "string") {
    const parsed = Date.parse(current);
    if (Number.isFinite(parsed)) return new Date(Date.now() - 60_000).toISOString();
    return String(Math.floor(Date.now() / 1000) - 60);
  }
  return new Date(Date.now() - 60_000).toISOString();
}

function setFirstExpiryDeep(value, nextValue, depth = 0) {
  if (depth > 8 || !isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (["expiresat", "expires_at", "expiry", "expires"].includes(key.toLowerCase())) {
      value[key] = nextValue;
      return true;
    }
  }
  for (const entry of Object.values(value)) {
    if (setFirstExpiryDeep(entry, nextValue, depth + 1)) return true;
  }
  return false;
}

function setFirstAccessTokenDeep(value, nextValue, depth = 0) {
  if (depth > 8 || !isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (["accesstoken", "access_token"].includes(key.toLowerCase()) && typeof value[key] === "string") {
      value[key] = nextValue;
      return true;
    }
  }
  for (const entry of Object.values(value)) {
    if (setFirstAccessTokenDeep(entry, nextValue, depth + 1)) return true;
  }
  return false;
}

async function forceNativeCredentialExpired(ctx, credential) {
  const nextValue = pastExpiryValue(credential.expiresAt);
  const expiryUpdated = setFirstExpiryDeep(credential.credential, nextValue);
  const accessUpdated = setFirstAccessTokenDeep(credential.credential, "eyJhbGciOiJFZERTQSJ9.eyJleHAiOjF9.invalid");
  ctx.assert(expiryUpdated && accessUpdated, "Native OpenCode mcp-auth.json exposes access-token and expiry fields to make the local credential stale.");
  await writeFile(state.nativeAuthFilePath, `${JSON.stringify(credential.parsed, null, 2)}\n`, "utf8");
}

function commandLooksAuthenticated(result) {
  const summary = summarizeCommandResult(result);
  return result.exitCode === 0 && summary.mentionsOpenwork && summary.mentionsAuthenticated && summary.mentionsOAuth && !summary.containsUnredactedToken;
}

function commandLooksConnected(result) {
  const summary = summarizeCommandResult(result);
  return result.exitCode === 0 && summary.mentionsOpenwork && summary.mentionsConnected && !summary.containsUnredactedToken;
}

async function clearDenWebSession(ctx) {
  await navigateBrowser(ctx, webBaseUrl(), "Den Web before OAuth sign-in");
  await ctx.eval(`fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .catch(() => null)
    .then(() => { localStorage.clear(); sessionStorage.clear(); return true; })`, { awaitPromise: true });
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => ctx.log(`Cookie clear skipped: ${error instanceof Error ? error.message : String(error)}`));
    await ctx.client.send("Network.clearBrowserCache", {}).catch(() => undefined);
  }
}

async function clickEnabledButton(ctx, pattern, label) {
  const result = await ctx.waitFor(`(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const target = buttons.find((button) => {
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
      const text = (button.textContent || button.value || '').trim();
      return !disabled && ${pattern}.test(text || button.getAttribute('aria-label') || '');
    });
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    target?.click();
    return target ? (target.textContent || target.value || target.getAttribute('aria-label') || '').trim() : null;
  })()`, { timeoutMs: 20_000, label });
  ctx.log(`Clicked ${label}: ${result}`);
  return result;
}

async function submitSignIn(ctx) {
  const emailSelector = 'input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"]';
  const passwordSelector = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return Boolean(document.querySelector(${JSON.stringify(emailSelector)}))
      || Boolean(document.querySelector('input[name="mcp-organization"], input[type="radio"]'))
      || text.includes('Choose workspace');
  })()`, { timeoutMs: 60_000, label: "OpenWork OAuth sign-in or consent" });

  const alreadyAtConsent = await ctx.eval(`Boolean(document.querySelector('input[name="mcp-organization"], input[type="radio"]'))`);
  if (alreadyAtConsent) return "already signed in";

  await ctx.eval(`(() => {
    const activeSubmit = document.querySelector('button[type="submit"]');
    if ((activeSubmit?.textContent || '').includes('Sign in')) return true;
    const signIn = Array.from(document.querySelectorAll('button, a')).find((entry) => (entry.textContent || '').trim() === 'Sign in');
    signIn?.click();
    return true;
  })()`);
  await ctx.fill(emailSelector, DEMO_EMAIL);

  const passwordVisibleBeforeContinue = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(passwordSelector)}))`);
  if (!passwordVisibleBeforeContinue) {
    await clickEnabledButton(ctx, "/^(continue|next|sign in|log in)$/i", "email-first continue").catch(() => undefined);
    await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(passwordSelector)}))`, { timeoutMs: 30_000, label: "password field after email-first step" });
  }

  await ctx.fill(passwordSelector, DEMO_PASSWORD);
  await clickEnabledButton(ctx, "/(sign in|log in|continue)/i", "submit sign-in form");
  return "submitted credentials";
}

async function currentPageUrlSummary(ctx) {
  const href = await ctx.eval("location.href");
  return summarizeUrlForEvidence(href);
}

async function replaceCurrentUrlWithQueryless(ctx) {
  const before = await currentPageUrlSummary(ctx);
  const afterHref = await ctx.eval(`(() => {
    const url = new URL(location.href);
    history.replaceState(history.state, document.title, url.origin + url.pathname);
    return location.href;
  })()`);
  return { before, after: summarizeUrlForEvidence(afterHref) };
}

async function screenshotWithTemporarilyQuerylessUrl(ctx, name, options) {
  const before = await currentPageUrlSummary(ctx);
  const sanitizedHref = await ctx.eval(`(() => {
    window.__openworkReliableConnectRawHref = location.href;
    const url = new URL(location.href);
    history.replaceState(history.state, document.title, url.origin + url.pathname);
    return location.href;
  })()`);
  const sanitized = summarizeUrlForEvidence(sanitizedHref);
  try {
    await ctx.screenshot(name, options);
  } finally {
    await ctx.eval(`(() => {
      const rawHref = window.__openworkReliableConnectRawHref;
      if (typeof rawHref === "string" && rawHref.length > 0) {
        history.replaceState(history.state, document.title, rawHref);
      }
      delete window.__openworkReliableConnectRawHref;
      return true;
    })()`).catch((error) => ctx.log(`Consent URL restore skipped: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { before, sanitized, restored: await currentPageUrlSummary(ctx) };
}

async function waitForOrganizationConsent(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    const radios = document.querySelectorAll('input[name="mcp-organization"], input[type="radio"]').length;
    return radios > 0 || text.includes("don't belong to any workspaces") || text.includes('Sign in before authorizing');
  })()`, { timeoutMs: 60_000, label: "MCP organization consent list" });
  const consentUrl = await currentPageUrlSummary(ctx);
  const consentState = await ctx.eval(`(() => {
    const bodyText = document.body.innerText || "";
    return {
      radios: document.querySelectorAll('input[name="mcp-organization"], input[type="radio"]').length,
      bodyTextLength: bodyText.length,
      hasChooseWorkspaceCopy: bodyText.includes('Choose workspace') || bodyText.includes('CHOOSE WORKSPACE'),
      hasNoWorkspaceCopy: bodyText.includes("don't belong to any workspaces"),
      hasSignInBeforeAuthorizingCopy: bodyText.includes('Sign in before authorizing'),
    };
  })()`);
  consentState.url = consentUrl;
  ctx.recordEvidence({ type: "output", name: "Consent page state", text: JSON.stringify(consentState, null, 2) });
  ctx.assert(consentState.radios > 0, `Consent page did not list organizations. Summary: ${JSON.stringify(consentState)}`);
}

async function selectAcmeOrganization(ctx) {
  const label = await ctx.waitFor(`(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((entry) => (entry.textContent || '').includes('Acme Robotics'))
      || labels.find((entry) => entry.querySelector('input[name="mcp-organization"], input[type="radio"]'));
    if (!target) return null;
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    const input = target.querySelector('input') || target;
    input.click();
    return (target.textContent || '').replace(/\\s+/g, ' ').trim();
  })()`, { timeoutMs: 30_000, label: "available organization option" });
  return label;
}

async function clickAuthorizeAndContinue(ctx) {
  await clickEnabledButton(ctx, "/authorize/i", "Authorize and continue");
}

function summarizeTokenResponse(body, prior) {
  const access = readString(body, "access_token");
  const refresh = readString(body, "refresh_token");
  return {
    status: "token-response-redacted",
    tokenType: readString(body, "token_type"),
    expiresIn: readNumber(body, "expires_in"),
    scope: readString(body, "scope"),
    accessToken: tokenShape(access),
    refreshToken: tokenShape(refresh),
    accessTokenReplaced: prior?.access ? access.length > 0 && access !== prior.access : undefined,
    refreshTokenReplaced: prior?.refresh ? refresh.length > 0 && refresh !== prior.refresh : undefined,
  };
}

async function tokenEndpointRequest(form) {
  const tokenEndpoint = readString(state.authorizationServerMetadata, "token_endpoint");
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  const { text, body } = await readResponseBody(response);
  const endpointUrl = new URL(tokenEndpoint);
  return {
    status: response.status,
    ok: response.ok,
    requestId: response.headers.get("x-request-id") ?? "",
    retryAfter: response.headers.get("retry-after") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    requestPath: endpointUrl.pathname,
    body,
    bodyReference: bodyReference(body),
    rawBodyHash: shortHash(text),
  };
}

async function exchangeCodeForToken() {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", state.authorizationCode);
  form.set("redirect_uri", state.redirectUri);
  form.set("client_id", readString(state.registration?.body, "client_id"));
  form.set("code_verifier", state.pkce?.verifier ?? "");
  form.set("resource", readString(state.protectedResourceMetadata, "resource"));
  return tokenEndpointRequest(form);
}

async function refreshTokens(refreshToken) {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", state.nativeClientId || readString(state.registration?.body, "client_id"));
  form.set("refresh_token", refreshToken);
  form.set("resource", readString(state.protectedResourceMetadata, "resource"));
  return tokenEndpointRequest(form);
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

async function mcpCall(token, method, params) {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP ${method} returned no data frame: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(dataLine.slice(5));
  if (parsed.error) throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return { result: parsed.result, requestId: response.headers.get("x-request-id") ?? "", rawHash: hashText(raw).slice(0, 12) };
}

function extractOrganizationName(payload) {
  return readString(payload?.organization, "name")
    || readString(payload?.org, "name")
    || readString(payload, "name")
    || readString(payload, "organizationName");
}

async function startHtmlReportServer(html) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function closeReportServer(ctx, key) {
  const server = state[key];
  if (!server) return;
  state[key] = null;
  await server.close().catch((error) => ctx.log(`Report server cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
}

function renderProofPage(proof) {
  const checks = proof.checks.map((check) => `<li><strong>${escapeHtml(check.label)}:</strong> ${escapeHtml(check.value)}</li>`).join("\n");
  const commandRows = proof.commands.map((command) => `<tr>
    <th>${escapeHtml(command.label)}</th>
    <td>exit ${escapeHtml(String(command.exitCode))}; stdout <code>${escapeHtml(command.stdoutHash)}</code>; stderr <code>${escapeHtml(command.stderrHash)}</code>; openwork=${escapeHtml(String(command.mentionsOpenwork))}; oauth=${escapeHtml(String(command.mentionsOAuth))}; connected=${escapeHtml(String(command.mentionsConnected))}; authenticated=${escapeHtml(String(command.mentionsAuthenticated))}</td>
  </tr>`).join("\n");
  const credentialRows = Object.entries(proof.credentialSummary).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Reliable OpenWork Connect proof</title>
    <style>
      body { margin: 0; background: #f8fafc; color: #0f172a; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 1040px; margin: 0 auto; padding: 36px; }
      h1 { font-size: 34px; margin: 0 0 8px; }
      section { margin-top: 22px; padding: 22px; border: 1px solid #dbeafe; border-radius: 20px; background: white; box-shadow: 0 18px 60px rgba(15, 23, 42, .08); }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .badge { display: inline-flex; margin: 4px 6px 4px 0; padding: 4px 10px; border-radius: 999px; background: #dcfce7; color: #166534; font-weight: 700; font-size: 12px; }
      code { background: #eef2ff; border-radius: 8px; padding: 2px 6px; }
      li { margin: 8px 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; border-top: 1px solid #e2e8f0; padding: 8px; vertical-align: top; }
      th { width: 220px; color: #475569; }
    </style>
  </head>
  <body>
    <main>
      <p class="badge">Connected</p><p class="badge">No tokens shown</p><p class="badge">Native OpenCode</p>
      <h1>Reliable OpenWork Connect proof</h1>
      <p>Landing UI contract: <code>${escapeHtml(proof.canonicalServerUrl)}</code></p>
      <p>Runtime under test: <code>${escapeHtml(proof.runtimeServerUrl)}</code>. ${escapeHtml(proof.urlContract)}</p>
      <div class="grid">
        <section>
          <h2>Live OAuth + MCP checks</h2>
          <ul>${checks}</ul>
        </section>
        <section>
          <h2>Native command output hashes</h2>
          <table>${commandRows}</table>
        </section>
        <section>
          <h2>Redacted mcp-auth.json summary</h2>
          <table>${credentialRows}</table>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function renderErrorMatrixPage(matrix) {
  const rows = matrix.rows.map((row) => `<tr>
    <td>${escapeHtml(row.scenario)}</td>
    <td>${escapeHtml(row.status)}</td>
    <td><code>${escapeHtml(row.requestId)}</code></td>
    <td><code>${escapeHtml(row.bodyReference)}</code></td>
    <td>${escapeHtml(row.contract)}</td>
  </tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenWork Connect error matrix</title>
    <style>
      body { margin: 0; background: #fff7ed; color: #111827; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 1120px; margin: 0 auto; padding: 36px; }
      h1 { margin: 0 0 8px; font-size: 34px; }
      p { color: #4b5563; }
      table { width: 100%; border-collapse: collapse; background: white; border-radius: 18px; overflow: hidden; box-shadow: 0 18px 60px rgba(15,23,42,.12); }
      th, td { padding: 14px 16px; border-bottom: 1px solid #fed7aa; text-align: left; vertical-align: top; }
      th { background: #ffedd5; color: #9a3412; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      code { background: #ffedd5; border-radius: 8px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>OpenWork Connect error matrix</h1>
      <p>Every row is from a real HTTP response and includes an <strong>X-Request-Id</strong> plus a body reference. Tokens are redacted.</p>
      <table>
        <thead><tr><th>Scenario</th><th>Status</th><th>X-Request-Id</th><th>Body reference</th><th>Contract</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function responseHasBodyReference(response) {
  return typeof response.bodyReference === "string" && response.bodyReference.length > 0;
}

function responseHasMatchingReference(response) {
  return Boolean(response.requestId) && responseHasBodyReference(response) && response.bodyReference === response.requestId;
}

async function malformedAuthenticatedRequest() {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${state.currentAccessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now() }),
  });
  return captureHttpResponse("malformed authenticated JSON-RPC", response);
}

async function missingBearerRequest() {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "initialize", params: initializeParams() }),
  });
  return captureHttpResponse("missing bearer discovery", response);
}

async function invalidBearerRequest() {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer ow_mcp_at_invalid_or_expired_contract",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "initialize", params: initializeParams() }),
  });
  return captureHttpResponse("invalid/expired bearer contract", response);
}

async function concurrentRefreshRequests() {
  const [first, second] = await Promise.all([refreshTokens(state.concurrentRefreshToken), refreshTokens(state.concurrentRefreshToken)]);
  return [first, second].map((entry, index) => ({
    label: `concurrent refresh ${index + 1}`,
    status: entry.status,
    ok: entry.ok,
    requestId: entry.requestId,
    retryAfter: entry.retryAfter,
    requestPath: entry.requestPath,
    body: sanitizeValue(entry.ok ? summarizeTokenResponse(entry.body) : entry.body),
    bodyReference: entry.bodyReference,
    rawBodyHash: entry.rawBodyHash,
  }));
}

function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

async function runMysql(ctx, sql) {
  const container = ctx.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER.trim();
  const database = ctx.env.OPENWORK_EVAL_DEN_MYSQL_DATABASE.trim();
  const password = process.env.OPENWORK_EVAL_DEN_MYSQL_ROOT_PASSWORD?.trim() || "password";
  try {
    const { stdout, stderr } = await execFileAsync("docker", [
      "exec",
      container,
      "mysql",
      "-uroot",
      `-p${password}`,
      database,
      "-N",
      "-B",
      "-e",
      sql,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    if (stderr.trim()) ctx.log(`mysql stderr hash ${shortHash(stderr)}`);
    return stdout.trim();
  } catch (error) {
    throw new Error(`mysql command failed without exposing SQL or secrets; diagnostic hash ${shortHash(error instanceof Error ? error.stack ?? error.message : String(error))}`);
  }
}

async function cleanupOAuthClientById(ctx, phase) {
  if (!state.nativeClientId) {
    return { phase, skipped: true, reason: "No generated native client_id is available yet." };
  }
  const clientId = sqlString(state.nativeClientId);
  const output = await runMysql(ctx, [
    `DELETE FROM \`oauthAccessToken\` WHERE \`client_id\` = ${clientId}; SELECT ROW_COUNT();`,
    `DELETE FROM \`oauthRefreshToken\` WHERE \`client_id\` = ${clientId}; SELECT ROW_COUNT();`,
    `DELETE FROM \`oauthConsent\` WHERE \`client_id\` = ${clientId}; SELECT ROW_COUNT();`,
    `DELETE FROM \`oauthClient\` WHERE \`client_id\` = ${clientId}; SELECT ROW_COUNT();`,
  ].join(" "));
  return {
    phase,
    clientIdHash: shortHash(state.nativeClientId),
    deletedRows: output.split(/\s+/).filter(Boolean).map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)),
  };
}

const BETTER_AUTH_EVAL_RATE_LIMIT_PATHS = [
  "/sign-in/email",
  "/sign-out",
  "/organization/set-active",
  "/oauth2/register",
  "/oauth2/authorize",
  "/oauth2/consent",
  "/oauth2/token",
];

async function cleanupEvalRateLimits(ctx, phase) {
  ctx.assert(
    ctx.env.OPENWORK_EVAL_ISOLATED_DATABASE.trim() === "1",
    "Rate-limit cleanup requires OPENWORK_EVAL_ISOLATED_DATABASE=1 and must never run against a shared database.",
  );
  const predicates = BETTER_AUTH_EVAL_RATE_LIMIT_PATHS
    .map((path) => `\`key\` LIKE ${sqlString(`%|${path}`)}`)
    .join(" OR ");
  const output = await runMysql(ctx, `DELETE FROM \`rate_limit\` WHERE ${predicates}; SELECT ROW_COUNT();`);
  return {
    phase,
    scopedKeyPatterns: BETTER_AUTH_EVAL_RATE_LIMIT_PATHS.length,
    deletedRows: Number(output.split(/\s+/).filter(Boolean).at(-1) ?? "0"),
  };
}

async function generateLiveRateLimit(ctx) {
  const maxAttempts = Number(process.env.OPENWORK_EVAL_OAUTH_RATE_LIMIT_MAX_ATTEMPTS?.trim() || "80");
  const tokenEndpoint = readString(state.authorizationServerMetadata, "token_endpoint");
  const tokenEndpointUrl = new URL(tokenEndpoint);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("client_id", state.nativeClientId);
    form.set("refresh_token", `invalid-refresh-${state.nativeRunId}-${attempt}`);
    form.set("resource", readString(state.protectedResourceMetadata, "resource"));
    const response = await tokenEndpointRequest(form);
    state.rateLimitAttempts = attempt;
    if (response.status === 429) {
      return {
        label: "OAuth invalid refresh rate limit",
        status: response.status,
        ok: false,
        requestId: response.requestId,
        retryAfter: response.retryAfter,
        contentType: response.contentType,
        requestPath: response.requestPath,
        tokenEndpointPath: tokenEndpointUrl.pathname,
        clientIdHash: shortHash(state.nativeClientId),
        resource: readString(state.protectedResourceMetadata, "resource"),
        attempts: attempt,
        body: sanitizeValue(response.body),
        bodyReference: response.bodyReference,
        rawBodyHash: response.rawBodyHash,
      };
    }
    if (response.retryAfter) {
      await sleep(Math.min(Number(response.retryAfter) * 1000 || 250, 1_000));
    } else {
      await sleep(75);
    }
  }
  throw new Error(`No live OAuth 429 was returned after ${maxAttempts} bounded invalid refresh attempts against ${tokenEndpointUrl.pathname}.`);
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function expireCurrentAccessTokenSession(ctx) {
  const payload = decodeJwtPayload(state.currentAccessToken);
  const sid = readString(payload, "sid");
  ctx.assert(sid.length > 0, "Current native JWT access token contains a session id claim for local-only revocation testing.");
  const output = await runMysql(ctx, `UPDATE \`session\` SET \`expires_at\` = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE \`id\` = ${sqlString(sid)}; SELECT ROW_COUNT();`);
  return { sidHash: shortHash(sid), updatedRows: Number(output.split(/\s+/).filter(Boolean).at(-1) ?? "0") };
}

async function revokedSessionRequest() {
  const response = await fetch(mcpServerUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${state.currentAccessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }),
  });
  return captureHttpResponse("expired/revoked auth session", response);
}

async function cleanupNativeState(ctx) {
  await killNativeAuthProcess(ctx);
  const cleanup = { logout: null, db: null, rateLimits: null, browser: null, tempRemoved: false };
  if (state.nativeTempRoot) {
    cleanup.logout = summarizeCommandResult(await runNativeOpenCode(["mcp", "logout", MCP_NAME], "opencode mcp logout", 30_000));
  }
  cleanup.db = await cleanupOAuthClientById(ctx, "end").catch((error) => ({ phase: "end", errorHash: shortHash(error instanceof Error ? error.stack ?? error.message : String(error)) }));
  cleanup.browser = await clearDenWebSession(ctx)
    .then(() => ({ signedOutAndCookiesCleared: true }))
    .catch((error) => ({ signedOutAndCookiesCleared: false, errorHash: shortHash(error instanceof Error ? error.stack ?? error.message : String(error)) }));
  cleanup.rateLimits = await cleanupEvalRateLimits(ctx, "end").catch((error) => ({ phase: "end", errorHash: shortHash(error instanceof Error ? error.stack ?? error.message : String(error)) }));
  await closeNativeBrowserCaptureServer(ctx);
  state.nativeCapturedBrowserUrls = [];
  state.nativeBrowserCaptureSummaries = [];
  if (state.nativeTempRoot) {
    const root = state.nativeTempRoot;
    await rm(root, { recursive: true, force: true });
    state.nativeTempRoot = "";
    state.nativeEnv = null;
    state.nativeBrowserCaptureBinDir = "";
    state.nativeAuthStdoutChunks = null;
    state.nativeAuthStderrChunks = null;
    cleanup.tempRemoved = true;
  }
  state.nativeCleanup = cleanup;
  ctx.recordEvidence({ type: "output", name: "Native cleanup summary", text: JSON.stringify(cleanup, null, 2) });
}

function matrixRow(scenario, response, contract) {
  return {
    scenario,
    status: String(response.status),
    requestId: response.requestId,
    bodyReference: response.bodyReference,
    contract,
  };
}

async function navigateDocsPage(ctx) {
  const url = `${baseUrlFromEnv(ctx, "OPENWORK_EVAL_DOCS_URL")}/cloud/run-in-the-cloud/cloud-mcp`;
  await navigateBrowser(ctx, url, "OpenWork Connect docs page");
  await ctx.waitFor(
    `(() => {
      const root = document.querySelector('article, main') || document.body;
      const text = root.innerText || "";
      return text.includes(${JSON.stringify(PUBLIC_MCP_SERVER_URL)}) && text.includes('OpenWork Connect MCP');
    })()`,
    { timeoutMs: 30_000, label: "OpenWork Connect docs content" },
  );
  return url;
}

export default {
  id: FLOW_ID,
  title: "Reliable OpenWork Connect is proven from landing page to OAuth, MCP tools, errors, and docs",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: [
    "OPENWORK_EVAL_LANDING_URL",
    "OPENWORK_EVAL_DOCS_URL",
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_MYSQL_CONTAINER",
    "OPENWORK_EVAL_DEN_MYSQL_DATABASE",
    "OPENWORK_EVAL_ISOLATED_DATABASE",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("OpenWork Connect publishes the permanent MCP server URL and labels only native-proven clients as verified.", {
          voiceover: vo[0],
          action: async () => {
            state.landingUrl = await ensureLandingConnect(ctx);
            state.landingVisiblePanels = await collectVisibleClientPanels(ctx);
            await clickClientTab(ctx, "OpenCode");
          },
          assert: async () => {
            const pageState = await ctx.eval(`(() => {
              const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
              const text = section ? section.innerText : "";
              return { href: location.href, hasPublicUrl: text.includes(${JSON.stringify(PUBLIC_MCP_SERVER_URL)}), text };
            })()`);
            const statuses = visibleStatusSummary(state.landingVisiblePanels);
            const verifiedLabels = Object.entries(statuses).filter(([, panel]) => panel.status === "Verified").map(([label]) => label).sort();
            const setupLabels = Object.entries(statuses).filter(([, panel]) => panel.status === "Setup only").map(([label]) => label).sort();
            recordAssertion(
              ctx,
              "The browser is on the exact landing #connect-mcp URL and the public MCP endpoint is visible",
              pageState.href === state.landingUrl && pageState.hasPublicUrl === true,
              { href: pageState.href, expectedHref: state.landingUrl, hasPublicUrl: pageState.hasPublicUrl },
            );
            recordAssertion(
              ctx,
              "Every client status was collected from a visible selected panel, with only OpenCode marked Verified",
              JSON.stringify(verifiedLabels) === JSON.stringify(["OpenCode"])
                && setupLabels.length === CLIENT_EXPECTATIONS.length - 1
                && CLIENT_EXPECTATIONS.every((client) => statuses[client.label]?.selected === client.label && statuses[client.label]?.hidden === false && statuses[client.label]?.statusVisible === true),
              { verifiedLabels, setupLabels, statuses },
            );
          },
          screenshot: { name: "frame-1-landing-connect-mcp", requireText: [PUBLIC_MCP_SERVER_URL, "OpenCode", "Verified"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Real client tabs reveal the exact OpenCode verified and Codex setup-only install, auth, and reconnect sequences.", {
          voiceover: vo[1],
          action: async () => {
            await ensureLandingConnect(ctx);
            state.installVisiblePanels = await collectVisibleClientPanels(ctx);
            await clickClientTab(ctx, "OpenCode");
            await ctx.eval(`document.querySelector(${JSON.stringify(ACTIVE_PANEL_SELECTOR)})?.scrollIntoView({ block: "start", behavior: "instant" }); true`);
          },
          assert: async () => {
            const panels = state.installVisiblePanels;
            const opencode = panels.OpenCode.text;
            const codex = panels.Codex.text;
            const selected = await visiblePanelSnapshot(ctx);
            recordAssertion(
              ctx,
              "Every panel was inspected while selected and explains how OAuth starts for that client",
              CLIENT_EXPECTATIONS.every((client) => {
                const panel = panels[client.label];
                return panel?.selected === client.label
                  && panel.hidden === false
                  && panel.status === client.status
                  && panel.statusVisible === true
                  && client.oauthNeedles.every((needle) => panel.text.includes(needle));
              }),
              visibleStatusSummary(panels),
            );
            recordAssertion(
              ctx,
              "OpenCode shows the remote JSON config, opencode auth command, and logout-then-auth reconnect sequence",
              opencode.includes('"type": "remote"')
                && opencode.includes('"enabled": true')
                && opencode.includes('"oauth": {}')
                && opencode.includes(PUBLIC_MCP_SERVER_URL)
                && opencode.includes(OPENCODE_AUTH_COMMAND)
                && opencode.indexOf("opencode mcp logout openwork") >= 0
                && opencode.indexOf(OPENCODE_AUTH_COMMAND, opencode.indexOf("opencode mcp logout openwork")) > opencode.indexOf("opencode mcp logout openwork"),
              { selected: panels.OpenCode.selected, panelText: opencode },
            );
            recordAssertion(
              ctx,
              "Codex shows the add command, login command, and logout-then-login reconnect sequence",
              codex.includes(CODEX_COMMAND)
                && codex.includes(CODEX_LOGIN_COMMAND)
                && codex.indexOf("codex mcp logout openwork") >= 0
                && codex.indexOf(CODEX_LOGIN_COMMAND, codex.indexOf("codex mcp logout openwork")) > codex.indexOf("codex mcp logout openwork"),
              { selected: panels.Codex.selected, panelText: codex },
            );
            recordAssertion(
              ctx,
              "The final visible panel is OpenCode after the real tab clicks",
              selected.selected === "OpenCode" && selected.hidden === false,
              selected,
            );
          },
          screenshot: { name: "frame-2-opencode-install", requireText: ["OpenCode", OPENCODE_AUTH_COMMAND, "RECONNECT OR SWITCH ORG"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        try {
          await ctx.prove("The browser OAuth journey signs in, selects an organization, shows consent, and returns code plus state only.", {
            voiceover: vo[2],
            action: async () => {
              await applyDesktopViewport(ctx);
              const rateLimitReset = await cleanupEvalRateLimits(ctx, "start");
              ctx.recordEvidence({ type: "output", name: "Scoped Better Auth rate-limit cleanup start", text: JSON.stringify(rateLimitReset) });
              await prepareNativeOpenCodeEnvironment();
              const startCleanup = await cleanupOAuthClientById(ctx, "start");
              ctx.recordEvidence({ type: "output", name: "Native OAuth DB cleanup start", text: JSON.stringify(startCleanup, null, 2) });
              state.unauthenticatedInitialize = await postUnauthenticatedInitialize();
              state.protectedResourceMetadataUrl = state.unauthenticatedInitialize.resourceMetadataUrl;
              state.protectedResourceMetadata = await fetchJson(state.protectedResourceMetadataUrl);
              const authorizationServers = Array.isArray(state.protectedResourceMetadata.authorization_servers)
                ? state.protectedResourceMetadata.authorization_servers
                : [];
              const authorizationServer = typeof authorizationServers[0] === "string" ? authorizationServers[0] : "";
              state.authorizationServerMetadataUrl = authorizationServerMetadataUrl(authorizationServer);
              state.authorizationServerMetadata = await fetchJson(state.authorizationServerMetadataUrl);

              await startNativeAuthProcess();
              state.nativeAuthorizeUrl = await waitForCapturedAuthorizeUrl(ctx);
              await closeNativeBrowserCaptureServer(ctx);
              state.authorizeUrl = state.nativeAuthorizeUrl;
              const authorize = new URL(state.nativeAuthorizeUrl);
              state.nativeRedirectUri = authorize.searchParams.get("redirect_uri") ?? "";
              state.redirectUri = state.nativeRedirectUri;
              state.oauthState = authorize.searchParams.get("state") ?? "";
              state.nativeClientId = authorize.searchParams.get("client_id") ?? "";
              await clearDenWebSession(ctx);
              await navigateBrowser(ctx, state.nativeAuthorizeUrl, "native OpenCode OAuth authorize URL");
              await submitSignIn(ctx);
              await waitForOrganizationConsent(ctx);
              state.selectedOrganizationLabel = await selectAcmeOrganization(ctx);
              const consentScreenshotUrl = await screenshotWithTemporarilyQuerylessUrl(ctx, "frame-3-consent-before-authorize", {
                claim: "OpenWork shows the selected organization on the MCP consent screen before authorization.",
                voiceover: vo[2],
                requireText: ["CHOOSE WORKSPACE", "Authorize"],
                rejectText: ["access_token", "refresh_token"],
              });
              ctx.recordEvidence({ type: "output", name: "Consent screenshot URL sanitization", text: JSON.stringify(consentScreenshotUrl, null, 2) });
              await clickAuthorizeAndContinue(ctx);
              await ctx.waitFor(`(() => {
                try {
                  const url = new URL(location.href);
                  return ["127.0.0.1", "localhost"].includes(url.hostname)
                    && url.searchParams.has("code")
                    && url.searchParams.has("state");
                } catch {
                  return false;
                }
              })()`, { timeoutMs: 45_000, label: "native OpenCode loopback callback" });
              const callback = await ctx.eval(`(() => {
                const url = new URL(location.href);
                return {
                  origin: url.origin,
                  pathname: url.pathname,
                  codeLength: (url.searchParams.get("code") || "").length,
                  state: url.searchParams.get("state") || "",
                  hasAccessToken: url.searchParams.has("access_token"),
                  hasRefreshToken: url.searchParams.has("refresh_token"),
                  hasIdToken: url.searchParams.has("id_token"),
                  hasTokenType: url.searchParams.has("token_type"),
                };
              })()`);
              state.callback = {
                origin: callback.origin,
                pathname: callback.pathname,
                codeLength: callback.codeLength,
                stateHash: shortHash(callback.state),
                stateMatchesAuthorizeState: callback.state === state.oauthState,
                hasAccessToken: callback.hasAccessToken,
                hasRefreshToken: callback.hasRefreshToken,
                hasIdToken: callback.hasIdToken,
                hasTokenType: callback.hasTokenType,
              };
              state.nativeAuthResult = await waitForNativeAuthExit(ctx);
              state.nativeAuthFilePath = resolveNativeAuthFilePath();
              const callbackScreenshotUrl = await replaceCurrentUrlWithQueryless(ctx);
              ctx.recordEvidence({ type: "output", name: "Callback screenshot URL sanitization", text: JSON.stringify(callbackScreenshotUrl, null, 2) });
              await ctx.screenshot("frame-3-native-loopback-callback", {
                claim: "The real native OpenCode loopback callback is loaded after authorization and does not expose tokens in the URL.",
                voiceover: vo[2],
                rejectText: ["access_token", "refresh_token", "id_token"],
              });
            },
            assert: async () => {
              const authorize = new URL(state.nativeAuthorizeUrl);
              const callbackSummary = state.callback;
              const authSummary = state.nativeAuthResult ? summarizeCommandResult(state.nativeAuthResult) : null;
              const expectedProtectedMetadataUrl = protectedResourceMetadataUrl(mcpServerUrl());
              const issuer = Array.isArray(state.protectedResourceMetadata.authorization_servers) && typeof state.protectedResourceMetadata.authorization_servers[0] === "string"
                ? state.protectedResourceMetadata.authorization_servers[0]
                : "";
              const expectedAuthorizationMetadataUrl = issuer ? authorizationServerMetadataUrl(issuer) : "";
              recordAssertion(
                ctx,
                "Native OpenCode used exact RFC9728 discovery, standards-priority authorization metadata, exact runtime resource, state, and PKCE S256",
                state.unauthenticatedInitialize.status === 401
                  && state.protectedResourceMetadataUrl === expectedProtectedMetadataUrl
                  && readString(state.protectedResourceMetadata, "resource") === mcpServerUrl()
                  && state.authorizationServerMetadataUrl === expectedAuthorizationMetadataUrl
                  && new URL(state.authorizationServerMetadataUrl).pathname === "/.well-known/oauth-authorization-server/api/auth"
                  && readString(state.authorizationServerMetadata, "authorization_endpoint").length > 0
                  && readString(state.authorizationServerMetadata, "token_endpoint").length > 0
                  && readString(state.authorizationServerMetadata, "registration_endpoint").length > 0
                  && state.nativeClientId.length > 0
                  && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(state.nativeRedirectUri)
                  && authorize.searchParams.get("resource") === mcpServerUrl()
                  && authorize.searchParams.get("code_challenge_method") === "S256"
                  && (authorize.searchParams.get("code_challenge") ?? "").length > 20
                  && (authorize.searchParams.get("state") ?? "").length > 10
                  && authorize.searchParams.getAll("resource").length === 1,
                {
                  unauthenticatedStatus: state.unauthenticatedInitialize.status,
                  resourceMetadataUrl: state.protectedResourceMetadataUrl,
                  expectedProtectedMetadataUrl,
                  resource: readString(state.protectedResourceMetadata, "resource"),
                  authorizationServerMetadataUrl: state.authorizationServerMetadataUrl,
                  expectedAuthorizationMetadataUrl,
                  authorizeSummary: authorizeUrlEvidenceSummary(state.nativeAuthorizeUrl),
                  canonicalUiContract: PUBLIC_MCP_SERVER_URL,
                  runtimeResourceUnderTest: mcpServerUrl(),
                },
              );
              recordAssertion(
                ctx,
                "The browser selected an organization and the native loopback callback contains code plus matching state only, while OpenCode exits 0 and persists mcp-auth.json",
                state.selectedOrganizationLabel.length > 0
                  && state.callback !== null
                  && state.callback.codeLength > 0
                  && state.callback.stateMatchesAuthorizeState
                  && !state.callback.hasAccessToken
                  && !state.callback.hasRefreshToken
                  && !state.callback.hasIdToken
                  && !state.callback.hasTokenType
                  && state.nativeAuthResult?.exitCode === 0
                  && existsSync(state.nativeAuthFilePath)
                  && authSummary?.containsUnredactedToken === false,
                { selectedOrganizationLabel: state.selectedOrganizationLabel, callbackSummary, authSummary, authFileHash: shortHash(state.nativeAuthFilePath) },
              );
            },
          });
        } catch (error) {
          await replaceCurrentUrlWithQueryless(ctx).catch((sanitizeError) => ctx.log(`Frame 3 failure URL sanitization skipped: ${sanitizeError instanceof Error ? sanitizeError.message : String(sanitizeError)}`));
          throw error;
        } finally {
          const cleanup = await cleanupEvalRateLimits(ctx, "frame-3-finally")
            .catch((error) => ({ phase: "frame-3-finally", errorHash: shortHash(error instanceof Error ? error.stack ?? error.message : String(error)) }));
          ctx.recordEvidence({ type: "output", name: "Scoped Better Auth rate-limit cleanup after Frame 3", text: JSON.stringify(cleanup) });
          await closeLoopback(ctx);
          await closeNativeBrowserCaptureServer(ctx);
          if (state.nativeAuthChild) await killNativeAuthProcess(ctx);
        }
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        try {
          await ctx.prove("Public OAuth uses JWT access tokens plus rotating opaque refresh tokens while the verified client searches and executes OpenWork capabilities for the selected org.", {
            voiceover: vo[3],
            action: async () => {
              const nativeBefore = await readNativeCredential();
              state.nativeCredentialBeforeRefresh = nativeBefore;
              state.nativeClientId = nativeBefore.clientId || state.nativeClientId;
              state.firstAccessToken = nativeBefore.accessToken;
              state.firstRefreshToken = nativeBefore.refreshToken;

              state.nativeAuthList = await runNativeOpenCode(["mcp", "auth", "list"], "opencode mcp auth list");
              state.nativeMcpListBeforeRefresh = await runNativeOpenCode(["mcp", "list"], "opencode mcp list before forced expiry");

              state.mcpInitialize = await mcpCall(nativeBefore.accessToken, "initialize", initializeParams());
              state.toolsList = await mcpCall(nativeBefore.accessToken, "tools/list", {});
              const search = await mcpCall(nativeBefore.accessToken, "tools/call", {
                name: "search_capabilities",
                arguments: { query: "get organization", limit: 10 },
              });
              state.searchPayload = parseJsonText(readFirstText(search.result));
              const execute = await mcpCall(nativeBefore.accessToken, "tools/call", {
                name: "execute_capability",
                arguments: { name: "getOrg" },
              });
              state.executePayload = parseJsonText(readFirstText(execute.result));
              state.organizationName = extractOrganizationName(state.executePayload);

              await forceNativeCredentialExpired(ctx, nativeBefore);
              state.nativeMcpListAfterRefresh = await runNativeOpenCode(["mcp", "list"], "opencode mcp list after forced expiry");
              const nativeAfter = await readNativeCredential();
              state.nativeCredentialAfterRefresh = nativeAfter;
              state.currentAccessToken = nativeAfter.accessToken;
              state.concurrentRefreshToken = nativeAfter.refreshToken;
              state.refreshedToolsList = await mcpCall(nativeAfter.accessToken, "tools/list", {});
              const refreshedExecute = await mcpCall(nativeAfter.accessToken, "tools/call", {
                name: "execute_capability",
                arguments: { name: "getOrg" },
              });
              state.refreshedExecutePayload = parseJsonText(readFirstText(refreshedExecute.result));

              const toolNames = (state.toolsList.result?.tools ?? []).map((tool) => tool.name).sort();
              const commandSummaries = [
                summarizeCommandResult(state.nativeAuthList),
                summarizeCommandResult(state.nativeMcpListBeforeRefresh),
                summarizeCommandResult(state.nativeMcpListAfterRefresh),
              ];
              state.frame4Proof = {
                canonicalServerUrl: PUBLIC_MCP_SERVER_URL,
                runtimeServerUrl: mcpServerUrl(),
                urlContract: PUBLIC_MCP_SERVER_URL === mcpServerUrl()
                  ? "The canonical production URL is the runtime resource for this run."
                  : "The landing page displays the canonical production URL; this run exercises the dynamic preview resource shown here.",
                checks: [
                  { label: "mcp-auth.json", value: `JWT access ${tokenShape(nativeBefore.accessToken).jwt}; opaque refresh ${tokenShape(nativeBefore.refreshToken).opaque}; expiry ${nativeBefore.expiresAt !== undefined}; client metadata ${nativeBefore.clientMetadataPresent}` },
                  { label: "tools/list", value: toolNames.join(", ") },
                  { label: "search_capabilities", value: `getOrg found: ${Array.isArray(state.searchPayload?.matches) && state.searchPayload.matches.some((match) => match.name === "getOrg")}` },
                  { label: "execute_capability", value: `organization: ${state.organizationName}` },
                  { label: "Native automatic refresh", value: `mcp list recovered a stale local access credential by rotating access+refresh without logout/auth; refreshed access returned ${extractOrganizationName(state.refreshedExecutePayload)}` },
                ],
                commands: commandSummaries,
                credentialSummary: nativeCredentialSummary(nativeAfter),
              };
              state.frame4ReportServer = await startHtmlReportServer(renderProofPage(state.frame4Proof));
              await navigateBrowser(ctx, state.frame4ReportServer.url, "frame 4 proof page");
            },
            assert: async () => {
              const toolNames = (state.toolsList.result?.tools ?? []).map((tool) => tool.name).sort();
              const refreshedToolNames = (state.refreshedToolsList.result?.tools ?? []).map((tool) => tool.name).sort();
              const matches = Array.isArray(state.searchPayload?.matches) ? state.searchPayload.matches : [];
              const beforeSummary = nativeCredentialSummary(state.nativeCredentialBeforeRefresh);
              const afterSummary = nativeCredentialSummary(state.nativeCredentialAfterRefresh);
              const commandSummaries = [state.nativeAuthList, state.nativeMcpListBeforeRefresh, state.nativeMcpListAfterRefresh].map((result) => summarizeCommandResult(result));
              ctx.recordEvidence({ type: "output", name: "Redacted native OpenCode summaries", text: JSON.stringify({ beforeSummary, afterSummary, commandSummaries }, null, 2) });
              recordAssertion(
                ctx,
                "Native OpenCode mcp-auth.json contains a JWT access token, opaque refresh token, expiry, and client metadata without exposing secrets",
                beforeSummary.accessToken.present === true
                  && beforeSummary.accessToken.jwt === true
                  && beforeSummary.refreshToken.present === true
                  && beforeSummary.refreshToken.opaque === true
                  && beforeSummary.expiresAtPresent === true
                  && beforeSummary.clientIdPresent === true
                  && beforeSummary.clientMetadataPresent === true
                  && !looksLikeUnredactedToken(JSON.stringify(beforeSummary)),
                beforeSummary,
              );
              recordAssertion(
                ctx,
                "Native opencode mcp auth list and mcp list exit successfully and report authenticated connected OAuth for openwork from real command output",
                commandLooksAuthenticated(state.nativeAuthList)
                  && commandLooksConnected(state.nativeMcpListBeforeRefresh),
                commandSummaries,
              );
              recordAssertion(
                ctx,
                "MCP initialize/tools/list/search/execute expose exactly two tools and return the selected organization",
                JSON.stringify(toolNames) === JSON.stringify(EXPECTED_TOOLS)
                  && matches.some((match) => match.name === "getOrg")
                  && state.organizationName.length > 0,
                { toolNames, matches: matches.map((match) => match.name), organizationName: state.organizationName, initializeRequestId: state.mcpInitialize.requestId },
              );
              recordAssertion(
                ctx,
                "Making the local access credential stale makes native mcp list refresh access+refresh without reconnect and the refreshed access token still executes getOrg",
                state.nativeCredentialAfterRefresh.accessToken.length > 0
                  && state.nativeCredentialAfterRefresh.refreshToken.length > 0
                  && state.nativeCredentialAfterRefresh.accessToken !== state.nativeCredentialBeforeRefresh.accessToken
                  && state.nativeCredentialAfterRefresh.refreshToken !== state.nativeCredentialBeforeRefresh.refreshToken
                  && commandLooksConnected(state.nativeMcpListAfterRefresh)
                  && JSON.stringify(refreshedToolNames) === JSON.stringify(EXPECTED_TOOLS)
                  && extractOrganizationName(state.refreshedExecutePayload) === state.organizationName,
                { afterSummary, refreshedToolNames, refreshedOrganization: extractOrganizationName(state.refreshedExecutePayload), command: summarizeCommandResult(state.nativeMcpListAfterRefresh) },
              );
            },
            screenshot: { name: "frame-4-native-client-proof", requireText: ["Native command output hashes", "search_capabilities", "execute_capability", "Native automatic refresh"] },
          });
        } finally {
          await closeReportServer(ctx, "frame4ReportServer");
        }
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        try {
          await ctx.prove("OpenWork Connect returns standards-compliant, traceable error responses for the failure modes clients hit.", {
            voiceover: vo[4],
            action: async () => {
              const rateLimitReset = await cleanupEvalRateLimits(ctx, "frame-5-start");
              ctx.recordEvidence({ type: "output", name: "Scoped Better Auth rate-limit cleanup before Frame 5", text: JSON.stringify(rateLimitReset) });
              const malformed = await malformedAuthenticatedRequest();
              const missingBearer = await missingBearerRequest();
              const invalidBearer = await invalidBearerRequest();
              const concurrent = await concurrentRefreshRequests();
              const rateLimit = await generateLiveRateLimit(ctx);
              state.expiredSession = await expireCurrentAccessTokenSession(ctx);
              const revokedSession = await revokedSessionRequest();
              state.revokedSessionResponse = revokedSession;
              state.frame5Matrix = { malformed, missingBearer, invalidBearer, concurrent, rateLimit, revokedSession };
              const rows = [
                matrixRow("400 JSON-RPC malformed authenticated MCP request", malformed, "Malformed authenticated JSON-RPC returns 400 with JSON-RPC error details."),
                matrixRow("401 missing bearer discovery", missingBearer, "Missing bearer returns WWW-Authenticate with RFC9728 resource metadata."),
                matrixRow("401 invalid/expired bearer contract", invalidBearer, "Invalid or expired bearer returns invalid_token challenge."),
                ...concurrent.map((entry) => matrixRow(`Concurrent refresh response ${entry.ok ? "success" : "invalid_grant"}`, entry, "The same refresh grant produces exactly one success and one invalid_grant, never a 500; the family is invalidated and reconnect is required.")),
                matrixRow("429 OAuth rate limit", rateLimit, "Hosted OAuth rate limiting is generated live at the discovered token endpoint with Retry-After and support reference."),
                matrixRow("401 expired/revoked auth session", revokedSession, "A JWT whose sid row was expired in MySQL is rejected with mcp_session_revoked/invalid_token."),
              ];
              state.frame5ReportServer = await startHtmlReportServer(renderErrorMatrixPage({ rows }));
              await navigateBrowser(ctx, state.frame5ReportServer.url, "frame 5 error matrix page");
            },
            assert: async () => {
              const { malformed, missingBearer, invalidBearer, concurrent, rateLimit, revokedSession } = state.frame5Matrix;
              const errorResponses = [malformed, missingBearer, invalidBearer, ...concurrent.filter((entry) => !entry.ok), rateLimit, revokedSession];
              const successfulConcurrentRefresh = concurrent.find((entry) => entry.ok);
              const concurrentStatuses = concurrent.map((entry) => entry.status).sort((a, b) => a - b);
              const invalidGrant = concurrent.find((entry) => !entry.ok);
              recordAssertion(
                ctx,
                "Every live error response has X-Request-Id matching body referenceId/reference_id, while the successful concurrent refresh is traceable and no response exposes tokens",
                errorResponses.every((entry) => responseHasMatchingReference(entry) && !looksLikeUnredactedToken(JSON.stringify(entry)))
                  && Boolean(successfulConcurrentRefresh?.requestId)
                  && !looksLikeUnredactedToken(JSON.stringify(successfulConcurrentRefresh)),
                concurrent.concat(errorResponses).map((entry) => ({ label: entry.label, status: entry.status, requestId: entry.requestId, bodyReference: entry.bodyReference })),
              );
              recordAssertion(
                ctx,
                "Malformed authenticated MCP request returns a 400 JSON-RPC error response",
                malformed.status === 400
                  && isRecord(malformed.body)
                  && readString(malformed.body, "jsonrpc") === "2.0"
                  && isRecord(malformed.body.error),
                malformed,
              );
              recordAssertion(
                ctx,
                "Missing bearer and invalid/expired bearer responses advertise discovery and invalid_token contracts",
                missingBearer.status === 401
                  && missingBearer.wwwAuthenticate.includes("resource_metadata")
                  && missingBearer.wwwAuthenticate.includes(state.protectedResourceMetadataUrl)
                  && invalidBearer.status === 401
                  && invalidBearer.wwwAuthenticate.includes("invalid_token")
                  && isRecord(invalidBearer.body)
                  && readString(invalidBearer.body, "oauthError") === "invalid_token",
                { missingBearer, invalidBearer },
              );
              recordAssertion(
                ctx,
                "Concurrent refresh of the same refresh grant returns exactly one success and one invalid_grant with no 500, and the family is treated as invalidated/reconnect-required",
                JSON.stringify(concurrentStatuses) === JSON.stringify([200, 400])
                  && invalidGrant !== undefined
                  && isRecord(invalidGrant.body)
                  && readString(invalidGrant.body, "error") === "invalid_grant"
                  && concurrent.every((entry) => entry.status !== 500),
                { concurrent, securityConclusion: "refresh-token replay invalidates the family; do not claim the winner remains refreshable; reconnect is required" },
              );
              recordAssertion(
                ctx,
                "Real hosted OAuth rate limiting was generated at the discovered token endpoint and returned 429, Retry-After, and matching request/body references",
                rateLimit.status === 429
                  && rateLimit.requestPath === new URL(readString(state.authorizationServerMetadata, "token_endpoint")).pathname
                  && rateLimit.requestPath === "/api/auth/oauth2/token"
                  && Boolean(rateLimit.retryAfter)
                  && responseHasMatchingReference(rateLimit),
                rateLimit,
              );
              recordAssertion(
                ctx,
                "Expiring the exact JWT sid row in MySQL makes replay of that access token fail as mcp_session_revoked invalid_token with matching references",
                state.expiredSession.updatedRows === 1
                  && revokedSession.status === 401
                  && isRecord(revokedSession.body)
                  && readString(revokedSession.body, "error") === "mcp_session_revoked"
                  && readString(revokedSession.body, "oauthError") === "invalid_token"
                  && responseHasMatchingReference(revokedSession),
                { expiredSession: state.expiredSession, revokedSession },
              );
            },
            screenshot: { name: "frame-5-error-matrix", requireText: ["400 JSON-RPC", "invalid_token", "Retry-After", "mcp_session_revoked", "X-Request-Id"] },
          });
        } finally {
          const cleanup = await cleanupEvalRateLimits(ctx, "frame-5-finally")
            .catch((error) => ({ phase: "frame-5-finally", errorHash: shortHash(error instanceof Error ? error.stack ?? error.message : String(error)) }));
          ctx.recordEvidence({ type: "output", name: "Scoped Better Auth rate-limit cleanup after Frame 5", text: JSON.stringify(cleanup) });
          await closeReportServer(ctx, "frame5ReportServer");
        }
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
          await ctx.prove("The docs match the shipped endpoint, OAuth behavior, client commands, troubleshooting, and support status.", {
            voiceover: vo[5],
            action: async () => {
              state.docsUrl = await navigateDocsPage(ctx);
              await ctx.eval(`(() => {
                const root = document.querySelector('article, main') || document.body;
                const headings = Array.from(root.querySelectorAll('h2, h3'));
                const target = headings.find((heading) => (heading.textContent || '').includes('Token lifetime'))
                  || headings.find((heading) => (heading.textContent || '').includes('Troubleshooting'));
                target?.scrollIntoView({ block: 'start', behavior: 'instant' });
                return true;
              })()`);
            },
            assert: async () => {
              const actual = await ctx.eval(`(() => {
                const root = document.querySelector('article, main') || document.body;
                const bodyText = root.innerText || "";
                const rows = Array.from(root.querySelectorAll('tr')).map((row) => {
                  const cells = Array.from(row.querySelectorAll('th, td')).map((cell) => (cell.innerText || '').replace(/\\s+/g, ' ').trim());
                  return { text: cells.join(' | '), cells };
                });
                return {
                  href: location.href,
                  hasEndpoint: bodyText.includes(${JSON.stringify(PUBLIC_MCP_SERVER_URL)}),
                  hasFifteenMinutes: bodyText.includes('15 minutes'),
                  hasThirtyDays: bodyText.includes('30-day inactivity window'),
                  hasJwtAccessTokenContract: bodyText.includes('JWTs signed and validated with EdDSA')
                    && bodyText.includes('issuer is exactly')
                    && bodyText.includes('audience is exactly'),
                  hasOpaqueRefreshTokenContract: bodyText.includes('Refresh tokens are opaque rotating grants'),
                  hasOpenCodeAuth: bodyText.includes(${JSON.stringify(OPENCODE_AUTH_COMMAND)}),
                  hasOpenCodeReconnect: bodyText.includes('opencode mcp logout openwork') && bodyText.includes(${JSON.stringify(OPENCODE_AUTH_COMMAND)}),
                  hasCodexAdd: bodyText.includes(${JSON.stringify(CODEX_COMMAND)}),
                  hasCodexLogin: bodyText.includes(${JSON.stringify(CODEX_LOGIN_COMMAND)}),
                  hasCodexReconnect: bodyText.includes('codex mcp logout openwork') && bodyText.includes(${JSON.stringify(CODEX_LOGIN_COMMAND)}),
                  rows,
                  hasRfc9728: bodyText.includes('RFC9728'),
                  hasExactResource: bodyText.includes('OAuth authorize and token requests must include exactly one') && bodyText.includes(${JSON.stringify(PUBLIC_MCP_SERVER_URL)}),
                  hasTroubleshooting: bodyText.includes('401 missing or invalid token')
                    && bodyText.includes('invalid_grant')
                    && bodyText.includes('429 rate limit')
                    && bodyText.includes('Retry-After'),
                  hasRequestId: bodyText.includes('X-Request-Id') && bodyText.includes('referenceId') && bodyText.includes('reference_id'),
                  hasInternalProxyWarning: bodyText.includes('app.openworklabs.com/api/den') && bodyText.includes('internal same-origin desktop proxy') && bodyText.includes('Do not paste it into external MCP clients'),
                  hasOrganizationSwitching: bodyText.includes('The organization you choose in the browser is pinned into the token') && bodyText.includes('logout/auth') && bodyText.includes('logout/login'),
                  hasStaleSevenDayClaim: /\b(?:7|seven)[ -]?day\b/i.test(bodyText),
                  hasOpaqueAccessTokenClaim: bodyText.includes('opaque bearer tokens') || bodyText.includes('Access tokens are opaque'),
                  hasJwksClaim: /\bJWKS\b/.test(bodyText),
                };
              })()`);
              const supportRows = Object.fromEntries(CLIENT_EXPECTATIONS.map((client) => [
                client.label,
                actual.rows.find((row) => row.cells.includes(client.label)) || { text: "", cells: [] },
              ]));
              const statusByClient = Object.fromEntries(CLIENT_EXPECTATIONS.map((client) => [client.label, supportRows[client.label].text]));
              recordAssertion(
                ctx,
                "Within article/main, the docs page URL and endpoint, token lifetime, auth commands, reconnect commands, and org switching copy match the shipped behavior",
                actual.href === state.docsUrl
                  && actual.hasEndpoint === true
                  && actual.hasFifteenMinutes === true
                  && actual.hasThirtyDays === true
                  && actual.hasJwtAccessTokenContract === true
                  && actual.hasOpaqueRefreshTokenContract === true
                  && actual.hasOpenCodeAuth === true
                  && actual.hasOpenCodeReconnect === true
                  && actual.hasCodexAdd === true
                  && actual.hasCodexLogin === true
                  && actual.hasCodexReconnect === true
                  && actual.hasOrganizationSwitching === true,
                { ...actual, statusByClient },
              );
              recordAssertion(
                ctx,
                "The article/main support table has exact client/status rows with only OpenCode Verified, plus RFC9728 details, troubleshooting, references, proxy warning, and no stale claims",
                CLIENT_EXPECTATIONS.every((client) => supportRows[client.label].cells.includes(client.label) && supportRows[client.label].cells.includes(client.status))
                  && Object.entries(supportRows).filter(([, row]) => row.cells.includes("Verified")).map(([label]) => label).join(",") === "OpenCode"
                  && actual.hasRfc9728 === true
                  && actual.hasExactResource === true
                  && actual.hasTroubleshooting === true
                  && actual.hasRequestId === true
                  && actual.hasInternalProxyWarning === true
                  && actual.hasStaleSevenDayClaim === false
                  && actual.hasOpaqueAccessTokenClaim === false
                  && actual.hasJwksClaim === false,
                { statusByClient, supportRows, actual },
              );
            },
            screenshot: { name: "frame-6-docs-contract", requireText: [PUBLIC_MCP_SERVER_URL, "JWTs", "15 minutes", "30-day inactivity window", "X-Request-Id"], rejectText: ["JWKS"] },
          });
        } finally {
          await cleanupNativeState(ctx);
        }
      },
    },
  ],
};
