import { createServer } from "node:http";
import type { Seed } from "@openwork/env";

/** A real upstream HTTP fixture: strict metadata stays held until the proof releases it. */
export async function customConnectorSetup(seed: Seed) {
  let origin = "";
  let providerHeld = true;
  let heldRequests = 0;
  let headerRequests = 0;
  let signInRequests = 0;
  const waiting: Array<() => void> = [];
  const release = () => { providerHeld = false; waiting.splice(0).forEach((resolve) => resolve()); };
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
        res.end(JSON.stringify(value));
      };
      if (["/authorize", "/token", "/register"].includes(path)) signInRequests++;
      if (path.startsWith("/mcp/")) {
        if (req.headers["x-example-key"] === "synthetic-review-header") headerRequests++;
        json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"${path.endsWith("/conflict") ? ', scope="read write"' : ""}` });
        return;
      }
      if (path.startsWith("/.well-known/oauth-protected-resource/mcp/")) {
        const name = path.split("/").at(-1) ?? "baseline";
        json({ resource: `${origin}/mcp/${name}`, authorization_servers: [`${origin}/${name}`], scopes_supported: ["read"] });
        return;
      }
      if (path.startsWith("/.well-known/oauth-authorization-server/")) {
        const name = path.split("/").at(-1) ?? "baseline";
        if (name === "held" && providerHeld) { heldRequests++; await new Promise<void>((resolve) => waiting.push(resolve)); }
        json({
          issuer: `${origin}/${name === "mismatch" ? "another-issuer" : name}`,
          authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
          scopes_supported: ["read", "write"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: name !== "own",
        });
        return;
      }
      json({}, 404);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const den = await seed.den({ env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "Fieldnotes Studio", admin: { name: "Connector Admin" } } });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1280, height: 1300 } });
    return {
      den, web,
      setupUrl: (name: string) => `${den.ref.webUrl}/dashboard/mcp-connections/new/custom?name=Project+tools&url=${encodeURIComponent(`${origin}/mcp/${name}`)}`,
      heldRequests: () => heldRequests,
      headerRequests: () => headerRequests,
      signInRequests: () => signInRequests,
      async savedConnections() {
        const result = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable");
        const body = result.body;
        if (typeof body !== "object" || body === null || !("connections" in body) || !Array.isArray(body.connections)) throw new Error("Connection list unavailable");
        return body.connections.length;
      },
      release,
      async [Symbol.asyncDispose]() { release(); provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve())); },
    };
  } catch (error) { release(); provider.closeAllConnections(); provider.close(); throw error; }
}
