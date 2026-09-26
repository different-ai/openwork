import { createHash, randomBytes } from "node:crypto";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

function clientIdFrom(value: unknown): string {
  const id = isRecord(value) ? value.client_id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Missing client_id");
  return id;
}

/**
 * A signed-in member and two MCP clients that ask for OpenWork access: one
 * whose only return address is this computer (loopback) and one that
 * returns to a public website.
 */
export async function mcpConsentClientIdentity(seed: Seed) {
  const den = await seed.den({ org: { name: "Consent identity org", members: {} } });
  const scope = "openid profile email mcp:read mcp:write";

  async function authorizeUrl(clientName: string, redirectUri: string) {
    const registered = await denFetch(den.ref, "/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope,
      }),
    });
    if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
    const query = new URLSearchParams({
      client_id: clientIdFrom(registered.body), redirect_uri: redirectUri, response_type: "code", scope,
      resource: `${den.ref.apiUrl}/mcp/agent`, state: randomBytes(8).toString("hex"), code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
    });
    return { clientId: clientIdFrom(registered.body), url: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}` };
  }

  const loopback = { name: "Terminal agent", redirectHost: "127.0.0.1:39422", ...await authorizeUrl("Terminal agent", "http://127.0.0.1:39422/callback") };
  const hosted = { name: "Hosted assistant", redirectHost: "assistant.example.com", ...await authorizeUrl("Hosted assistant", "https://assistant.example.com/oauth/callback") };
  const web = await seed.web({ den, headless: true, viewport: { width: 1280, height: 1000 } });
  return { den, web, loopback, hosted, admin: { email: den.admin.email, password: den.admin.password } };
}
