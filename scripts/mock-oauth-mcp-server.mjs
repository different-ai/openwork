#!/usr/bin/env node
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3978);
const issuer = process.env.ISSUER || `http://${host}:${port}`;
const autoApprove = process.env.AUTO_APPROVE !== "0";

const clients = new Map();
const codes = new Map();
const tokens = new Set();
const requests = [];

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
}

function protectedResourceMetadata() {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
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
  if (autoApprove) {
    redirectWithCode(res, url.searchParams);
    return;
  }

  const approveUrl = new URL(`${issuer}/approve`);
  for (const [key, value] of url.searchParams) approveUrl.searchParams.set(key, value);
  text(res, 200, `<!doctype html>
<html>
  <head><title>Mock MCP OAuth</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;">
    <h1>Mock MCP OAuth</h1>
    <p>This fake OAuth provider is for OpenWork MCP end-to-end tests.</p>
    <form method="post" action="${approveUrl.pathname}${approveUrl.search}">
      <button style="font: inherit; padding: 10px 14px;">Approve OpenWork</button>
    </form>
  </body>
</html>`);
}

async function registerClient(req, res) {
  const body = await readJson(req).catch(() => ({}));
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

async function issueToken(req, res) {
  const form = await readForm(req);
  const grantType = form.grant_type || "authorization_code";

  if (grantType === "authorization_code") {
    const grant = codes.get(form.code);
    if (!grant) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
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
  }

  if (form.code) codes.delete(form.code);
  const accessToken = `mock-access-${randomUUID()}`;
  tokens.add(accessToken);
  json(res, 200, {
    access_token: accessToken,
    refresh_token: `mock-refresh-${randomUUID()}`,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "mcp:read mcp:write",
  });
}

function isAuthorized(req) {
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
        ],
      };
    case "tools/call":
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

async function handleMcp(req, res) {
  if (!isAuthorized(req)) {
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
  const responses = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return [];
    return [{ jsonrpc: "2.0", id: message.id, result: mcpResult(message) }];
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
    record(req, url);

    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (url.pathname === "/health") {
      json(res, 200, { ok: true, issuer, autoApprove, requests: requests.length });
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
      await registerClient(req, res);
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
      await issueToken(req, res);
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
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
