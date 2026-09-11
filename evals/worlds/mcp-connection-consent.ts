import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen } from "./openwork-server-cli.ts";

export const consentCases = [
  { id: "write", scope: "mcp:read mcp:write offline_access", accept: true },
  { id: "read", scope: "mcp:read", accept: true },
  { id: "cancel", scope: "mcp:read mcp:write offline_access", accept: false },
];

export function requiredString(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

export async function mcpConnectionConsent(seed: Seed) {
  const den = await seed.den({
    org: { name: "Consent original workspace", members: {} },
    env: { DEN_MCP_CLAIM_NAMESPACE: "https://consent.example.test" },
  });
  if (!den.database) throw new Error("Browser consent requires an owned isolated Den, not an attached service.");
  const original = await seed.api(den.admin, "/v1/me/orgs");
  const orgs = isRecord(original.body) && Array.isArray(original.body.orgs) ? original.body.orgs : [];
  const originalOrgId = requiredString(orgs.find(org => isRecord(org) && org.name === "Consent original workspace"), "id");
  const selectedOrgName = "Consent selected workspace";
  const created = await seed.api(den.admin, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: selectedOrgName }),
  });
  if (!created.response.ok || !isRecord(created.body)) throw new Error(`Organization setup failed: HTTP ${created.response.status}`);
  const selectedOrgId = requiredString(created.body.organization, "id");

  const clients = new Map<string, { clientId: string; verifier: string; redirectUri: string; resource: string; state: string }>();
  const callbacks: Array<{
    path: string; hasCode: boolean; error: string | null; state: string | null;
    exchange: { status: number; scope: string; tokenScope: string; organizationId: string; jwt: boolean } | null;
  }> = [];
  const callback = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || !consentCases.some(entry => url.pathname === `/callback/${entry.id}`)) {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const client = clients.get(url.pathname);
    const received: (typeof callbacks)[number] = { path: url.pathname, hasCode: Boolean(code), error: url.searchParams.get("error"), state, exchange: null };
    try {
      // The synthetic client exchanges only the code delivered to its registered
      // callback, with its original state and PKCE verifier. No admin bearer is used.
      if (code && client && state === client.state) {
        const result = await denFetch(den.ref, "/api/auth/oauth2/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, code,
            code_verifier: client.verifier, redirect_uri: client.redirectUri, resource: client.resource }),
        });
        const token = isRecord(result.body) && typeof result.body.access_token === "string" ? result.body.access_token : "";
        const parts = token.split(".");
        const claims: unknown = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : null;
        received.exchange = { status: result.response.status, jwt: parts.length === 3,
          scope: isRecord(result.body) && typeof result.body.scope === "string" ? result.body.scope : "",
          tokenScope: isRecord(claims) && typeof claims.scope === "string" ? claims.scope : "",
          organizationId: isRecord(claims) && typeof claims["https://consent.example.test/org_id"] === "string" ? claims["https://consent.example.test/org_id"] : "" };
      }
    } catch {
      received.exchange = { status: 0, scope: "", tokenScope: "", organizationId: "", jwt: false };
    }
    callbacks.push(received);
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Consent callback</title><h1>Authorization returned to client</h1>");
  });
  const callbackOrigin = await listen(callback);
  try {
    const flows = [];
    for (const entry of consentCases) {
      const redirectUri = `${callbackOrigin}/callback/${entry.id}`;
      const registered = await denFetch(den.ref, "/register", {
        method: "POST",
        body: JSON.stringify({
          client_name: `Consent ${entry.id} client`, redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], scope: entry.scope,
        }),
      });
      if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
      const clientId = requiredString(registered.body, "client_id");
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(16).toString("hex");
      const resource = `${den.ref.apiUrl}/mcp/agent`;
      clients.set(`/callback/${entry.id}`, { clientId, verifier, redirectUri, resource, state });
      const query = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: entry.scope,
        resource, state, prompt: "consent", code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      const web = await seed.web({ den, headless: true, viewport: { width: 1440, height: 1100 } });
      flows.push({ ...entry, web, state,
        authorizeUrl: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}` });
    }
    return {
      den, flows, originalOrgId, selectedOrgId, selectedOrgName,
      callbacks: (id: string) => callbacks.filter(entry => entry.path === `/callback/${id}`).map(entry => ({ ...entry })),
      async [Symbol.asyncDispose]() { await close(callback); },
    };
  } catch (error) {
    await close(callback);
    throw error;
  }
}
