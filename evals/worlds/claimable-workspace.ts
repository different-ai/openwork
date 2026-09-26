import { denFetch } from "@openwork/behaviors";
import { personDefaults, type Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

function stringAt(value: unknown, ...path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  if (typeof current !== "string" || !current) throw new Error(`Missing ${path.join(".")}`);
  return current;
}

export type McpCall = { status: number; json: unknown; text: string };

/**
 * An agent with no OpenWork account and a person who has never signed up.
 * The agent talks to Den only over HTTP (bootstrap route, token endpoint, MCP
 * gateway), the person only through Den web in a browser.
 */
export async function claimableWorkspace(seed: Seed) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const person = personDefaults("claimer", undefined, runId);
  const den = await seed.den({
    org: { name: `Claim witness ${runId}`, members: {} },
    env: { DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "false", OPENWORK_DEV_MODE: "1" },
  });
  const web = await seed.web({ den, headless: true, viewport: { width: 1280, height: 900 } });
  const workspaceName = `Agent studio ${runId}`;

  /** The agent provisions a workspace with no account and keeps the assertion. */
  async function provision() {
    const created = await denFetch(den.ref, "/v1/bootstrap/workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceName, claimRoles: ["owner"] }),
    });
    if (created.response.status !== 200) throw new Error(`bootstrap failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return {
      organizationId: stringAt(created.body, "organization", "id"),
      bootstrapId: stringAt(created.body, "setup", "id"),
      assertion: stringAt(created.body, "identity", "assertion"),
      tokenEndpoint: stringAt(created.body, "identity", "tokenEndpoint"),
      hasClaimLinks: isRecord(created.body) && Array.isArray(created.body.claimLinks) && created.body.claimLinks.length > 0,
    };
  }

  /** RFC 7523 JWT-bearer exchange at Den's token endpoint. */
  async function exchange(assertion: string) {
    const result = await denFetch(den.ref, "/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const body = isRecord(result.body) ? result.body : {};
    return {
      status: result.response.status,
      accessToken: typeof body.access_token === "string" ? body.access_token : "",
      scope: typeof body.scope === "string" ? body.scope : "",
      error: typeof body.error === "string" ? body.error : "",
    };
  }

  let rpcId = 0;
  /** An MCP tools/call on the gateway with only the pre-claim token. */
  async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<McpCall> {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    if (!response.ok) return { status: response.status, json: null, text: raw.slice(0, 500) };
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = isRecord(frame) ? frame.result : null;
    const structured = isRecord(result) ? result.structuredContent : undefined;
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const text = content.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("");
    let json: unknown = structured ?? null;
    if (json === null) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: response.status, json, text: text.slice(0, 500) };
  }

  async function requestClaimCode(bootstrapId: string, assertion: string) {
    const result = await denFetch(den.ref, `/v1/bootstrap/workspace/${bootstrapId}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${assertion}` },
    });
    return {
      status: result.response.status,
      userCode: stringAt(result.body, "user_code"),
      verificationUrl: stringAt(result.body, "verification_uri_complete"),
    };
  }

  async function claimState(bootstrapId: string, assertion: string) {
    const result = await denFetch(den.ref, `/v1/bootstrap/workspace/${bootstrapId}/claim`, {
      method: "GET",
      headers: { authorization: `Bearer ${assertion}` },
    });
    const body = isRecord(result.body) ? result.body : {};
    return { status: result.response.status, state: typeof body.state === "string" ? body.state : "", reconciled: body.reconciled === true };
  }

  return { den, web, person, workspaceName, provision, exchange, callTool, requestClaimCode, claimState };
}
