import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { denFetch } from "@openwork/behaviors";
import { personDefaults, queryDenDatabase, type Seed } from "@openwork/env";
import { close, isRecord, listen } from "./openwork-server-cli.ts";

type TokenExchange = { status: number; accessToken: string; scope: string; organizationId: string };

function stringField(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

/**
 * A brand-new person, driven by their agent (a synthetic MCP client that
 * registers itself and opens the gateway's authorize URL, like Claude Code or
 * Codex), signs up in the browser. The only fixtures are the MCP client's
 * loopback callback and a no-sign-in MCP server the agent later adds.
 */
export async function agentMcpSignup(seed: Seed) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const person = personDefaults("agent-signup", undefined, runId);
  const den = await seed.den({
    org: { name: `Agent signup witness ${runId}`, members: {} },
    mocks: { tools: seed.mock({ allowUnauthenticatedMcp: true }) },
    env: {
      DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true", OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "", SMTP_HOST: "",
    },
  });
  if (!den.database) throw new Error("The verification-code witness needs the isolated Den database.");
  const databaseUrl = den.database.url;
  const tools = den.mocks.tools;

  const exchanges: TokenExchange[] = [];
  let client: { clientId: string; verifier: string; redirectUri: string; resource: string; state: string } | null = null;
  const callback = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    if (url.pathname === "/callback" && code && client && url.searchParams.get("state") === client.state) {
      const result = await denFetch(den.ref, "/api/auth/oauth2/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, code,
          code_verifier: client.verifier, redirect_uri: client.redirectUri, resource: client.resource }),
      }).catch(() => null);
      const accessToken = result && isRecord(result.body) && typeof result.body.access_token === "string" ? result.body.access_token : "";
      const parts = accessToken.split(".");
      const claims: unknown = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : null;
      const orgClaim = isRecord(claims) ? Object.entries(claims).find(([key]) => key.endsWith("org_id"))?.[1] : undefined;
      exchanges.push({
        status: result?.response.status ?? 0,
        accessToken,
        scope: result && isRecord(result.body) && typeof result.body.scope === "string" ? result.body.scope : "",
        organizationId: typeof orgClaim === "string" ? orgClaim : "",
      });
    }
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Agent connected</title><h1>Your agent is connected to OpenWork</h1>");
  });
  const callbackOrigin = await listen(callback);

  try {
    const redirectUri = `${callbackOrigin}/callback`;
    const scope = "openid profile email mcp:read mcp:write offline_access";
    const registered = await denFetch(den.ref, "/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent CLI", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope,
      }),
    });
    if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
    const verifier = randomBytes(32).toString("base64url");
    client = {
      clientId: stringField(registered.body, "client_id"), verifier, redirectUri,
      resource: `${den.ref.apiUrl}/mcp/agent`, state: randomBytes(16).toString("hex"),
    };
    const authorizeUrl = `${den.ref.apiUrl}/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope,
      resource: client.resource, state: client.state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })}`;
    const web = await seed.web({ den, headless: true, viewport: { width: 1440, height: 1000 } });

    let rpcId = 0;
    /** The agent's own MCP calls, made only with the token its callback received. */
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const token = exchanges.find((entry) => entry.accessToken)?.accessToken;
      if (!token) throw new Error("The agent has no MCP token yet");
      const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(120_000),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`MCP ${name}: HTTP ${response.status} ${raw.slice(0, 500)}`);
      const data = raw.split("\n").find((line) => line.startsWith("data:"));
      const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
      const result = isRecord(frame) ? frame.result : null;
      const structured = isRecord(result) ? result.structuredContent : undefined;
      if (isRecord(structured)) return { result, json: structured };
      const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
      const text = content.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("");
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = text; }
      return { result, json };
    };

    return {
      den, web, person, authorizeUrl, callbackOrigin, toolsMcpUrl: tools.mcpUrl,
      workspaceName: `Ada's studio ${runId}`,
      exchanges: () => exchanges.map((entry) => ({ ...entry })),
      /**
       * The 6-digit code better-auth stored for this person (plain storage), read
       * where the email template would print it; the local dev runner cannot
       * render the React email template, so the mailbox is not the witness.
       */
      async otp() {
        const rows = await queryDenDatabase(databaseUrl, "SELECT value FROM verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1", [`email-verification-otp-${person.email}`]);
        const value = isRecord(rows[0]) && typeof rows[0].value === "string" ? rows[0].value : "";
        return value.split(":")[0] ?? "";
      },
      callTool,
      async [Symbol.asyncDispose]() { await close(callback); },
    };
  } catch (error) {
    await close(callback);
    throw error;
  }
}
