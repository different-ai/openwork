import { randomBytes } from "node:crypto";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

function requiredString(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

/**
 * A registered OAuth client that then asks OpenWork to return to an address it
 * never registered. Better Auth cannot send that error back to the client, so
 * the browser must land on Den web's own error page.
 */
export async function denOAuthErrorPage(seed: Seed) {
  const den = await seed.den({ org: { name: "OAuth error page workspace", members: {} } });
  const registeredRedirect = "http://127.0.0.1:39421/callback";
  const registered = await denFetch(den.ref, "/register", {
    method: "POST",
    body: JSON.stringify({
      client_name: "Misconfigured MCP client", redirect_uris: [registeredRedirect],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], scope: "mcp:read",
    }),
  });
  if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
  const clientId = requiredString(registered.body, "client_id");
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: "http://127.0.0.1:39421/somewhere-else", response_type: "code",
    scope: "mcp:read", resource: `${den.ref.apiUrl}/mcp/agent`, state: randomBytes(8).toString("hex"),
    code_challenge_method: "S256", code_challenge: randomBytes(32).toString("base64url"),
  });
  const web = await seed.web({ den, headless: true, viewport: { width: 1440, height: 1100 } });
  return { den, web, clientId, authorizeUrl: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}` };
}
