#!/usr/bin/env node
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3978);
const issuer = process.env.ISSUER || `http://${host}:${port}`;
const autoApprove = process.env.AUTO_APPROVE !== "0";
const disableDcr = process.env.DISABLE_DCR === "1";
const strictOAuth = process.argv.includes("--strict") || process.env.STRICT_OAUTH === "1";
// Strict mode rejects refresh tokens this instance did not issue (and
// rotates on every refresh grant). Off by default: eval flows restart the
// mock mid-scenario and legitimately present pre-restart refresh tokens.
const strictRefreshTokens = process.env.STRICT_REFRESH_TOKENS === "1";
const mockClientId = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const mockClientSecret = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const preregisteredRedirectUris = (process.env.MOCK_REDIRECT_URIS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const advertisedScopes = ["mcp:read", "mcp:write"];
const extraToolName = (process.env.MOCK_EXTRA_TOOL_NAME || "").trim();
const extraToolTitle = (process.env.MOCK_EXTRA_TOOL_TITLE || extraToolName).trim();
const extraToolDescription = (process.env.MOCK_EXTRA_TOOL_DESCRIPTION || "Returns a fixed result from the mock OAuth MCP server.").trim();
const extraToolResult = process.env.MOCK_EXTRA_TOOL_RESULT || "mock oauth mcp ok";
const errorToolName = (process.env.MOCK_ERROR_TOOL_NAME || "").trim();
const errorToolTitle = (process.env.MOCK_ERROR_TOOL_TITLE || errorToolName).trim();
const errorToolDescription = (process.env.MOCK_ERROR_TOOL_DESCRIPTION || "Returns a provider policy error from the mock OAuth MCP server.").trim();
const errorToolStatus = Number(process.env.MOCK_ERROR_TOOL_STATUS || 403);
const errorToolMode = (process.env.MOCK_ERROR_TOOL_MODE || "result").trim();
const errorToolConnectUrl = (process.env.MOCK_ERROR_TOOL_CONNECT_URL || "https://connect.example.test/salesforce/start").trim();
const errorToolProvider = (process.env.MOCK_ERROR_TOOL_PROVIDER || "salesforce").trim();
const allowUnauthenticatedMcp = process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP === "1";

const clients = new Map();
const codes = new Map();
const tokens = new Set();
const refreshTokens = new Set();
const requests = [];
const drafts = [];

const gmailThreadId = "thread-q3-launch";

function gmailBodyData(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

const gmailThreadMessages = [
  {
    id: "msg-q3-kickoff",
    threadId: gmailThreadId,
    snippet: "Hi Sarah, Thursday still works for the Q3 launch prep.",
    payload: {
      headers: [
        { name: "From", value: "Jordan Demo <jordan.demo@acme.test>" },
        { name: "To", value: "Sarah Chen <sarah@acme.test>" },
        { name: "Subject", value: "Q3 launch" },
        { name: "Date", value: "Mon, 13 Jul 2026 16:30:00 -0700" },
        { name: "Message-ID", value: "<kickoff-1@acme.test>" },
      ],
      mimeType: "text/plain",
      body: {
        data: gmailBodyData([
          "Hi Sarah,",
          "Thursday still works for the Q3 launch prep.",
          "I am checking the final room details now.",
          "Jordan",
        ].join("\n")),
      },
    },
  },
  {
    id: "msg-q3-sarah-2",
    threadId: gmailThreadId,
    snippet: "Are we still on for Thursday? I need to confirm the room booking by Wednesday.",
    payload: {
      headers: [
        { name: "From", value: "Sarah Chen <sarah@acme.test>" },
        { name: "To", value: "Jordan Demo <jordan.demo@acme.test>" },
        { name: "Subject", value: "Re: Q3 launch" },
        { name: "Date", value: "Tue, 14 Jul 2026 09:15:00 -0700" },
        { name: "Message-ID", value: "<sarah-2@acme.test>" },
        { name: "References", value: "<kickoff-1@acme.test>" },
      ],
      mimeType: "text/plain",
      body: {
        data: gmailBodyData([
          "Are we still on for Thursday?",
          "I need to confirm the room booking by Wednesday.",
          "Also bringing the updated launch checklist.",
          "Sarah",
        ].join("\n")),
      },
    },
  },
];

const gmailMessagesById = new Map(gmailThreadMessages.map((message) => [message.id, message]));

function gmailMessageShape(message, format) {
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    payload: format === "full" ? message.payload : { headers: message.payload.headers },
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function record(req, url) {
  const entry = {
    id: requests.length + 1,
    method: req.method,
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    at: new Date().toISOString(),
  };
  requests.push(entry);
  console.log(`[mock-oauth-mcp] ${entry.method} ${entry.path}`);
  return entry;
}

function protectedResourceMetadata() {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: advertisedScopes,
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(disableDcr ? {} : { registration_endpoint: `${issuer}/register` }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: advertisedScopes,
  };
}

function basicClient(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return { clientId: decoded, clientSecret: "" };
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

function rejectInvalidPreregisteredClient(res) {
  json(res, 400, { error: "invalid_client" });
}

function requirePreregisteredAuthorizeClient(res, params) {
  if (!disableDcr) return true;
  if (params.get("client_id") === mockClientId) return true;
  rejectInvalidPreregisteredClient(res);
  return false;
}

function requireStrictAuthorizeContract(res, params) {
  if (!strictOAuth) return true;
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const registeredRedirects = clients.get(clientId)?.redirect_uris
    ?? (clientId === mockClientId ? preregisteredRedirectUris : []);
  if (!redirectUri || !registeredRedirects.includes(redirectUri)) {
    json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri did not match any configured URIs",
    });
    return false;
  }

  const scopes = (params.get("scope") || "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !advertisedScopes.includes(scope))) {
    json(res, 400, {
      error: "invalid_scope",
      error_description: "scope is required and must be advertised",
    });
    return false;
  }
  return true;
}

function requirePreregisteredTokenClient(req, res, form, grant) {
  if (!disableDcr) return true;
  const basic = basicClient(req);
  const clientId = basic?.clientId || form.client_id || grant?.clientId || "";
  if (clientId !== mockClientId) {
    rejectInvalidPreregisteredClient(res);
    return false;
  }
  const suppliedSecret = basic?.clientSecret ?? form.client_secret;
  if (suppliedSecret !== undefined && suppliedSecret !== mockClientSecret) {
    rejectInvalidPreregisteredClient(res);
    return false;
  }
  return true;
}

function redirectWithCode(res, params) {
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) {
    json(res, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
    return;
  }

  const code = `mock-code-${randomUUID()}`;
  codes.set(code, {
    clientId: params.get("client_id") || "mock-client",
    codeChallenge: params.get("code_challenge") || null,
    codeChallengeMethod: params.get("code_challenge_method") || "plain",
    scope: params.get("scope") || "mcp:read mcp:write",
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  const state = params.get("state");
  if (state) callback.searchParams.set("state", state);

  res.writeHead(302, { location: callback.toString() });
  res.end();
}

function authorize(req, res, url) {
  if (!requirePreregisteredAuthorizeClient(res, url.searchParams)) {
    return;
  }
  if (!requireStrictAuthorizeContract(res, url.searchParams)) {
    return;
  }
  if (autoApprove && url.searchParams.get("force_consent") !== "1") {
    redirectWithCode(res, url.searchParams);
    return;
  }

  const approveUrl = new URL(`${issuer}/approve`);
  for (const [key, value] of url.searchParams) approveUrl.searchParams.set(key, value);
  const requestedScopes = (url.searchParams.get("scope") || "").split(/\s+/).filter(Boolean);
  const requestedScopesHtml = requestedScopes.length > 0
    ? `<h2>Requested scopes</h2><ul>${requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")}</ul>`
    : "";
  text(res, 200, `<!doctype html>
<html>
  <head><title>Mock MCP OAuth</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;">
    <h1>Mock MCP OAuth</h1>
    <p>This fake OAuth provider is for OpenWork MCP end-to-end tests.</p>
    ${requestedScopesHtml}
    <form method="post" action="${approveUrl.pathname}${approveUrl.search}">
      <button style="font: inherit; padding: 10px 14px;">Approve OpenWork</button>
    </form>
  </body>
</html>`);
}

async function registerClient(req, res, entry) {
  if (disableDcr) {
    json(res, 404, { error: "not_found" });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  if (entry) {
    // Keep conformance evidence useful without recording credentials. These
    // are the public RFC 7591 fields OpenWork is expected to send.
    entry.registration = {
      application_type: body.application_type ?? null,
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      grant_types: Array.isArray(body.grant_types) ? body.grant_types : [],
      response_types: Array.isArray(body.response_types) ? body.response_types : [],
      scope: typeof body.scope === "string" ? body.scope : null,
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? null,
    };
  }
  const clientId = `mock-client-${randomUUID()}`;
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: body.token_endpoint_auth_method || "none",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:read mcp:write",
  };
  clients.set(clientId, client);
  json(res, 201, client);
}

async function issueToken(req, res, entry) {
  const form = await readForm(req);
  const grantType = form.grant_type || "authorization_code";
  if (entry) entry.grantType = grantType;
  let grantedScope = "mcp:read mcp:write";

  if (grantType === "authorization_code") {
    const grant = codes.get(form.code);
    if (!grant) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    if (!requirePreregisteredTokenClient(req, res, form, grant)) {
      return;
    }
    grantedScope = grant.scope;
    if (grant.codeChallenge) {
      const verifier = form.code_verifier || "";
      const expected =
        grant.codeChallengeMethod === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (expected !== grant.codeChallenge) {
        json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
  } else if (grantType === "refresh_token") {
    if (!requirePreregisteredTokenClient(req, res, form, null)) {
      return;
    }
    if (strictRefreshTokens) {
      if (!form.refresh_token || !refreshTokens.has(form.refresh_token)) {
        json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
        return;
      }
      // Rotate, like real providers (and the Den) do: the old refresh token
      // dies with this exchange, so the client must persist the replacement.
      refreshTokens.delete(form.refresh_token);
    }
  } else if (!requirePreregisteredTokenClient(req, res, form, null)) {
    return;
  }

  if (form.code) codes.delete(form.code);
  const accessToken = `mock-access-${randomUUID()}`;
  tokens.add(accessToken);
  const refreshToken = `mock-refresh-${randomUUID()}`;
  refreshTokens.add(refreshToken);
  json(res, 200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: grantedScope,
  });
}

function isAuthorized(req) {
  if (allowUnauthenticatedMcp) return true;
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && tokens.has(match[1]));
}

function mcpResult(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "mock_echo",
            title: "Mock Echo",
            description: "Echoes the provided text from the mock OAuth MCP server.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          ...(extraToolName ? [{
            name: extraToolName,
            title: extraToolTitle || extraToolName,
            description: extraToolDescription,
            inputSchema: {
              type: "object",
              properties: {
                channel: { type: "string" },
                unresolved: { type: "string" },
              },
            },
          }] : []),
          ...(errorToolName ? [{
            name: errorToolName,
            title: errorToolTitle || errorToolName,
            description: errorToolDescription,
            inputSchema: { type: "object", properties: {} },
          }] : []),
        ],
      };
    case "tools/call":
      if (errorToolName && message.params?.name === errorToolName) {
        return {
          isError: true,
          structuredContent: {
            providerStatus: Number.isFinite(errorToolStatus) ? errorToolStatus : 403,
            category: "provider_policy",
            providerCode: "access_denied",
          },
          content: [
            {
              type: "text",
              text: "The provider rejected this operation because administrator approval is required.",
            },
          ],
        };
      }
      if (extraToolName && message.params?.name === extraToolName) {
        return {
          content: [
            {
              type: "text",
              text: extraToolResult,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: String(message.params?.arguments?.text ?? "mock oauth mcp ok"),
          },
        ],
      };
    default:
      return {};
  }
}

function mcpResponse(message) {
  if (
    errorToolMode === "authorization_required"
    && errorToolName
    && message.method === "tools/call"
    && message.params?.name === errorToolName
  ) {
    const connectLink = `[${errorToolConnectUrl}](${errorToolConnectUrl})`;
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32001,
        message: `Authorization required — connect your ${errorToolProvider} account to use this connector. Open ${connectLink} in a browser, sign in, then retry this request.`,
        data: {
          connect_url: connectLink,
          provider: errorToolProvider,
        },
      },
    };
  }

  return { jsonrpc: "2.0", id: message.id, result: mcpResult(message) };
}

async function handleMcp(req, res) {
  const authorized = isAuthorized(req);
  if (!authorized) {
    json(res, 401, { error: "missing_mcp_token" }, {
      "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
    return;
  }

  if (req.method === "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  const body = await readJson(req).catch(() => ({}));
  const messages = Array.isArray(body) ? body : [body];
  const entry = requests[requests.length - 1];
  if (entry) {
    entry.authorized = authorized;
    entry.rpcMethods = messages
      .filter((message) => message && typeof message === "object" && typeof message.method === "string")
      .map((message) => message.method);
    entry.toolNames = messages
      .filter((message) => message && typeof message === "object" && message.method === "tools/call" && typeof message.params?.name === "string")
      .map((message) => message.params.name);
  }
  const responses = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return [];
    return [mcpResponse(message)];
  });

  if (responses.length === 0) {
    res.writeHead(202, { "access-control-allow-origin": "*" });
    res.end();
    return;
  }

  json(res, 200, Array.isArray(body) ? responses : responses[0]);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", issuer);
    const entry = record(req, url);

    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (url.pathname === "/health") {
      json(res, 200, { ok: true, issuer, autoApprove, disableDcr, requests: requests.length });
      return;
    }

    if (url.pathname === "/requests") {
      json(res, 200, { requests });
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/mcp/.well-known/oauth-protected-resource"
    ) {
      json(res, 200, protectedResourceMetadata());
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      json(res, 200, authorizationServerMetadata());
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      await registerClient(req, res, entry);
      return;
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      authorize(req, res, url);
      return;
    }

    if (url.pathname === "/approve" && req.method === "POST") {
      redirectWithCode(res, url.searchParams);
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      await issueToken(req, res, entry);
      return;
    }

    // Test hook: kill every live access token (refresh grants stay valid),
    // so the next authenticated MCP call gets a 401 challenge — the same
    // thing a client sees in production when its access token expires.
    if (url.pathname === "/admin/expire-access-tokens" && req.method === "POST") {
      const expired = tokens.size;
      tokens.clear();
      json(res, 200, { expired });
      return;
    }

    // Test hook: invalidate both access and refresh credentials. With
    // STRICT_REFRESH_TOKENS=1 the next authenticated MCP operation follows
    // the production-shaped 401 -> refresh -> invalid_grant path.
    if (url.pathname === "/admin/expire-oauth-tokens" && req.method === "POST") {
      const expiredAccessTokens = tokens.size;
      const expiredRefreshTokens = refreshTokens.size;
      tokens.clear();
      refreshTokens.clear();
      json(res, 200, { expiredAccessTokens, expiredRefreshTokens });
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    if (url.pathname === "/gmail/v1/users/me/messages" && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const messages = [...gmailThreadMessages].reverse().map((message) => ({
        id: message.id,
        threadId: message.threadId,
      }));
      json(res, 200, { messages, resultSizeEstimate: messages.length });
      return;
    }

    const gmailMessageMatch = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
    if (gmailMessageMatch && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const message = gmailMessagesById.get(decodeURIComponent(gmailMessageMatch[1]));
      if (!message) {
        json(res, 404, { error: { code: 404, message: "Message not found" } });
        return;
      }
      json(res, 200, gmailMessageShape(message, url.searchParams.get("format")));
      return;
    }

    if (url.pathname === `/gmail/v1/users/me/threads/${gmailThreadId}` && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      json(res, 200, {
        id: gmailThreadId,
        messages: gmailThreadMessages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
          payload: message.payload,
        })),
      });
      return;
    }

    // Minimal Gmail drafts.create stand-in so the org Google Workspace flow
    // can be proven end-to-end: requires a token this mock issued, records
    // the request (external witness), returns Gmail-shaped ids.
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const body = await readJson(req).catch(() => ({}));
      const raw = typeof body?.message?.raw === "string" ? body.message.raw : "";
      const threadId = typeof body?.message?.threadId === "string" ? body.message.threadId : null;
      drafts.push({ raw, threadId, at: new Date().toISOString() });
      json(res, 200, {
        id: `draft-${randomUUID()}`,
        message: { id: `msg-${randomUUID()}`, threadId: threadId || `thread-${randomUUID()}` },
      });
      return;
    }

    if (url.pathname === "/gmail/drafts-log") {
      json(res, 200, { drafts });
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`[mock-oauth-mcp] listening on ${issuer}`);
  console.log(`[mock-oauth-mcp] MCP URL: ${issuer}/mcp`);
  console.log(`[mock-oauth-mcp] set AUTO_APPROVE=0 to require an approval click`);
});
