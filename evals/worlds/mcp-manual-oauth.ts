import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

/** Neutral replay: login redirect, resource-path AS identifier, root metadata issuer. */
export async function manualOAuth(seed: Seed) {
  const requests: { path: string; method: string; rpc?: string; authorized: boolean; resource?: string; secretSent?: boolean }[] = [];
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const accessToken = randomBytes(24).toString("hex");
  let origin = "";
  let exchanges = 0;
  let differentPublishedHost = false;
  let credentialPublishedQuery = false;
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
      requests.push({ path: url.pathname, method: req.method ?? "GET", authorized, ...(isRecord(rpc) && typeof rpc.method === "string" ? { rpc: rpc.method } : {}), ...(url.pathname === "/token" ? { resource: params.get("resource") ?? "", secretSent: params.has("client_secret") } : {}) });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/mcp/team") {
        if (!authorized) { res.writeHead(302, { location: "/login", "content-type": "text/html" }).end("<!doctype html><title>exp-mcpmanual-login</title><h1>Sign in required</h1>"); return; }
        if (req.method === "DELETE") { res.writeHead(200).end(); return; }
        if (!isRecord(rpc) || !("id" in rpc)) { res.writeHead(202).end(); return; }
        if (rpc.method === "initialize") { json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "exp-mcpmanual-provider", version: "1.0.0" } } }); return; }
        if (rpc.method === "tools/list") { json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "exp_mcpmanual_ping", description: "Neutral connectivity check", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: {} } }] } }); return; }
        json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }); return;
      }
      if (url.pathname === "/login") { res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>exp-mcpmanual-login</title><h1>Sign in required</h1>"); return; }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp/team") { json({ resource: `${origin}/mcp/team`, authorization_servers: [`${origin}/mcp/team`] }); return; }
      if (url.pathname === "/.well-known/oauth-authorization-server/mcp/team") { const published = new URL(origin); if (differentPublishedHost) published.hostname = "localhost"; const authorization = new URL("/authorize", published); const token = new URL("/token", published); if (credentialPublishedQuery) { authorization.searchParams.set("access_token", "exp-mcpmanual-metadata-private"); token.searchParams.set("client_secret", "exp-mcpmanual-metadata-private"); } json({ issuer: origin, authorization_endpoint: authorization.href, token_endpoint: token.href, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return; }
      if (url.pathname === "/authorize") {
        if (url.searchParams.get("client_id") !== "exp-mcpmanual-client" || url.searchParams.get("code_challenge_method") !== "S256" || url.searchParams.get("resource") !== `${origin}/mcp/team`) { json({ error: "invalid_request" }, 400); return; }
        const approve = new URL(url); approve.pathname = "/approve";
        const action = approve.pathname + "?" + approve.searchParams.toString().replaceAll("&", "&amp;");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>exp-mcpmanual-authorization</title><style>body{margin:0;background:#f7f8fa;color:#172033;font:18px system-ui}main{max-width:560px;margin:140px auto;padding:44px;background:white;border:1px solid #dce1e8;border-radius:16px}h1{font-size:30px}p{line-height:1.6}button{background:#245bd7;color:white;border:0;border-radius:8px;padding:14px 22px;font:600 18px system-ui}</style></head><body><main><h1>Approve OpenWork sign-in</h1><p>Allow OpenWork to read the neutral MCP catalog for your disposable lab account?</p><form action="${action}" method="post"><button type="submit">Approve access</button></form></main></body></html>`); return;
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
        if (!grant || params.get("client_id") !== "exp-mcpmanual-client" || params.has("client_secret") || params.get("resource") !== `${origin}/mcp/team` || params.get("redirect_uri") !== grant.redirect || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) { json({ error: "invalid_grant" }, 400); return; }
        codes.delete(code); exchanges++; json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }); return;
      }
      json({}, 404);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const den = await seed.den({ env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "exp-mcpmanual-org", members: { member: { name: "Synthetic Member" } } } });
    const created = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: "exp-mcpmanual-provider", url: `${origin}/mcp/team`, authType: "oauth", credentialMode: "per_member", oauthClient: { clientId: "exp-mcpmanual-client" }, access: { orgWide: true } }) });
    if (!created.response.ok || !isRecord(created.body) || typeof created.body.id !== "string") throw new Error(`Connection setup failed: HTTP ${created.response.status}`);
    const connectionId = created.body.id;
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/your-connections", headless: true, viewport: { width: 1440, height: 1100 } });
    await web.client.send("Network.enable");
    await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*"] });
    return {
      den, web, requests, origin, connectionId, exchanges: () => exchanges,
      setPublishedDifferentHost: (value: boolean) => { differentPublishedHost = value; },
      setPublishedCredentialQuery: (value: boolean) => { credentialPublishedQuery = value; },
      async warningText() { return evaluate(web.client, () => document.querySelector('[data-testid="manual-oauth-trust-warning"]')?.textContent ?? ""); },
      async warningHost() { return evaluate(web.client, () => document.querySelector('[data-testid="manual-oauth-trust-warning"] strong')?.textContent ?? ""); },
      api: (path: string, init?: RequestInit) => seed.api(den.admin, path, init),
      memberApi: (path: string, init?: RequestInit) => seed.api(den.members.member, path, init),
      async connection(scope = "manageable") { const result = await seed.api(den.admin, `/v1/mcp-connections?scope=${scope}`); const rows = isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections : []; return rows.find(entry => isRecord(entry) && entry.id === connectionId); },
      async signInTab(): Promise<Surface | undefined> {
        const target = (await listTargets(web.handle.cdpUrl)).find(entry => {
          if (entry.type !== "page" || entry.id === web.client.targetId) return false;
          try { const url = new URL(entry.url); return url.origin === origin || (url.origin === new URL(den.ref.webUrl).origin && url.pathname === "/connect/oauth"); } catch { return false; }
        });
        return target ? { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) } : undefined;
      },
      async saveEnabled() { return evaluate(web.client, () => Array.from(document.querySelectorAll('button')).some(button => ["Save changes", "Save and use these addresses"].includes(button.textContent?.trim() ?? "") && !button.disabled)); },
      async advancedHealthy() { return evaluate(web.client, () => { const panel = document.querySelector('[data-testid="manual-oauth-settings"]'); if (!panel) return false; const box = panel.getBoundingClientRect(); return box.top >= 52 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth && !document.querySelector('[role="dialog"], [aria-modal="true"]'); }); },
      async healthy(tab: Surface) { return evaluate(tab.client, () => { const heading = document.querySelector("h1"); if (!heading) return false; const box = heading.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('[role="dialog"], [aria-modal="true"]'); }); },
      async [Symbol.asyncDispose]() { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); },
    };
  } catch (error) { provider.closeAllConnections(); provider.close(); throw error; }
}
