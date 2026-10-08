import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen } from "./openwork-server-cli.ts";

function clientIdFrom(value: unknown): string {
  const id = isRecord(value) ? value.client_id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Missing client_id");
  return id;
}

/**
 * A signed-in member and named loopback, named hosted, and unnamed MCP clients.
 * A local callback witnesses denial without contacting an external service.
 */
export async function mcpConsentClientIdentity(seed: Seed) {
  const den = await seed.den({ org: { name: "Consent identity org", members: {} } });
  const scope = "openid profile email mcp:read mcp:write";

  async function authorizeUrl(clientName: string | null, redirectUri: string) {
    const registered = await denFetch(den.ref, "/register", {
      method: "POST",
      body: JSON.stringify({
        ...(clientName ? { client_name: clientName } : {}), redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope,
      }),
    });
    if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
    const state = randomBytes(8).toString("hex");
    const query = new URLSearchParams({
      client_id: clientIdFrom(registered.body), redirect_uri: redirectUri, response_type: "code", scope,
      resource: `${den.ref.apiUrl}/mcp/agent`, state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
    });
    return { clientId: clientIdFrom(registered.body), redirectUri, state, url: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}`, authorizePath: `/api/auth/oauth2/authorize?${query}` };
  }

  /**
   * The consent page with a live signed query: authorize as the signed-in
   * member and follow Den's redirect onto /mcp/consent instead of the
   * workspace chooser, so the spec can show the consent step on its own.
   */
  async function consentUrl(authorizePath: string): Promise<string> {
    const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    });
    const cookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
    if (!cookie) throw new Error(`Could not sign in for the consent URL: HTTP ${signedIn.response.status}`);
    const authorized = await seed.api(den.admin, authorizePath, { headers: { cookie }, redirect: "manual" });
    const location = authorized.response.headers.get("location") ?? (isRecord(authorized.body) && typeof authorized.body.url === "string" ? authorized.body.url : "");
    if (!location) throw new Error(`Authorize did not redirect: HTTP ${authorized.response.status}`);
    const signed = new URL(location, den.ref.webUrl);
    return `${den.ref.webUrl}/mcp/consent${signed.search}`;
  }

  const callbacks: Array<{ hasCode: boolean; error: string | null; state: string | null }> = [];
  const callback = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    callbacks.push({ hasCode: url.searchParams.has("code"), error: url.searchParams.get("error"), state: url.searchParams.get("state") });
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Consent callback</title><h1>Authorization returned to client</h1>");
  });
  const callbackOrigin = await listen(callback);
  try {
    const loopback = { name: "Terminal agent", redirectHost: new URL(callbackOrigin).host, ...await authorizeUrl("Terminal agent", `${callbackOrigin}/callback`) };
    const hosted = { name: "Hosted assistant", redirectHost: "assistant.example.com", ...await authorizeUrl("Hosted assistant", "https://assistant.example.com/oauth/callback") };
    const unnamed = { redirectHost: "agent.example.net", ...await authorizeUrl(null, "https://agent.example.net/oauth/callback") };
    const web = await seed.web({ den, headless: true, viewport: { width: 1280, height: 1000 } });
    return {
      den, web, loopback, hosted, unnamed, consentUrl, admin: { email: den.admin.email, password: den.admin.password },
      callbacks: () => callbacks.map(entry => ({ ...entry })),
      async [Symbol.asyncDispose]() { await close(callback); },
    };
  } catch (error) {
    await close(callback);
    throw error;
  }
}
