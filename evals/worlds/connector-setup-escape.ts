import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

export const CLIENT_ID = "exp-escape-client";
export const CLIENT_SECRET = "exp-escape-synthetic-secret";

/**
 * A neutral OAuth MCP provider whose sign-in server refuses dynamic client
 * registration (invalid_redirect_uri) but accepts one pre-registered
 * confidential OAuth app. Serves two MCP paths so each test adds its own.
 */
export async function connectorSetupEscape(seed: Seed) {
  const requests: { path: string; method: string; rpc?: string; authorized: boolean; clientId?: string; secretSent?: boolean }[] = [];
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const accessToken = randomBytes(24).toString("hex");
  let origin = "";
  let exchanges = 0;
  let registrations = 0;
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const authorized = req.headers.authorization === `Bearer ${accessToken}`;
      let rpc: unknown;
      if (req.headers["content-type"]?.includes("application/json") && body) rpc = JSON.parse(body);
      const params = new URLSearchParams(body);
      const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
      const tokenClientId = basic?.[0] ?? params.get("client_id") ?? "";
      const tokenSecret = basic?.[1] ?? params.get("client_secret") ?? "";
      requests.push({ path: url.pathname, method: req.method ?? "GET", authorized, ...(isRecord(rpc) && typeof rpc.method === "string" ? { rpc: rpc.method } : {}), ...(url.pathname === "/token" ? { clientId: tokenClientId, secretSent: tokenSecret === CLIENT_SECRET } : {}) });
      const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/mcp/escape" || url.pathname === "/mcp/anyway") {
        if (!authorized) { json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}"` }); return; }
        if (req.method === "DELETE") { res.writeHead(200).end(); return; }
        if (!isRecord(rpc) || !("id" in rpc)) { res.writeHead(202).end(); return; }
        if (rpc.method === "initialize") { json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "exp-escape-provider", version: "1.0.0" } } }); return; }
        if (rpc.method === "tools/list") { json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "list_projects", description: "List projects in the disposable lab account.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } }] } }); return; }
        json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }); return;
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource/mcp/")) { json({ resource: `${origin}${url.pathname.replace("/.well-known/oauth-protected-resource", "")}`, authorization_servers: [origin] }); return; }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] });
        return;
      }
      if (url.pathname === "/register") { registrations++; json({ error: "invalid_redirect_uri", error_description: "This redirect address is not on the allowlist." }, 400); return; }
      if (url.pathname === "/authorize") {
        if (url.searchParams.get("client_id") !== CLIENT_ID || url.searchParams.get("code_challenge_method") !== "S256") { json({ error: "invalid_request" }, 400); return; }
        const approve = new URL(url); approve.pathname = "/approve";
        const action = approve.pathname + "?" + approve.searchParams.toString().replaceAll("&", "&amp;");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>exp-escape-authorization</title><style>body{margin:0;background:#f7f8fa;color:#172033;font:18px system-ui}main{max-width:560px;margin:140px auto;padding:44px;background:white;border:1px solid #dce1e8;border-radius:16px}h1{font-size:30px}button{background:#245bd7;color:white;border:0;border-radius:8px;padding:14px 22px;font:600 18px system-ui}</style></head><body><main><h1>Approve OpenWork sign-in</h1><p>Allow OpenWork to use your disposable lab account?</p><form action="${action}" method="post"><button type="submit">Approve access</button></form></main></body></html>`);
        return;
      }
      if (url.pathname === "/approve" && req.method === "POST") {
        const redirect = url.searchParams.get("redirect_uri"); const challenge = url.searchParams.get("code_challenge"); const state = url.searchParams.get("state");
        if (!redirect || !challenge || !state) { json({ error: "invalid_request" }, 400); return; }
        const code = randomBytes(24).toString("hex"); codes.set(code, { redirect, challenge });
        const callback = new URL(redirect); callback.searchParams.set("code", code); callback.searchParams.set("state", state);
        res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" }).end(); return;
      }
      if (url.pathname === "/token") {
        const code = params.get("code") ?? ""; const grant = codes.get(code);
        if (!grant || tokenClientId !== CLIENT_ID || tokenSecret !== CLIENT_SECRET || params.get("redirect_uri") !== grant.redirect || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) { json({ error: "invalid_grant" }, 400); return; }
        codes.delete(code); exchanges++; json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }); return;
      }
      json({}, 404);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const den = await seed.den({ env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "exp-escape-org" } });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1440, height: 1100 } });
    await web.client.send("Network.enable");
    await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*"] });
    const setupUrl = (path: string, name: string) => `${den.ref.webUrl}/dashboard/mcp-connections/new/custom?url=${encodeURIComponent(`${origin}${path}`)}&name=${encodeURIComponent(name)}`;
    return {
      den, web, requests, origin, setupUrl,
      exchanges: () => exchanges,
      registrations: () => registrations,
      async connections() {
        const result = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable");
        return isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections.filter(isRecord) : [];
      },
      async connectionFor(path: string) { return (await this.connections()).find(entry => entry.url === `${origin}${path}`); },
      async signInTab(): Promise<Surface | undefined> {
        const target = (await listTargets(web.handle.cdpUrl)).find(entry => {
          if (entry.type !== "page" || entry.id === web.client.targetId) return false;
          try { const url = new URL(entry.url); return url.origin === origin || (url.origin === new URL(den.ref.webUrl).origin && url.pathname === "/connect/oauth"); } catch { return false; }
        });
        return target ? { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) } : undefined;
      },
      async [Symbol.asyncDispose]() { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); },
    };
  } catch (error) { provider.closeAllConnections(); provider.close(); throw error; }
}
