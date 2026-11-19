import { createHash, randomBytes } from "node:crypto";
import { denFetch, type DenRef, type DenSession } from "./den.ts";

/**
 * Behaviors for the MCP gateway, consent, agent sign-up, CLI sign-in, remote
 * session, tenant isolation and private-key core journeys. Each one is what a
 * real client does over Den's public HTTP API, so a core spec can assert on
 * what that client observed.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

export interface McpToolCall { status: number; json: unknown }

/** One MCP tools/call on Den's agent gateway with a bearer token, as any MCP client makes it. */
export async function callAgentGatewayTool(apiUrl: string, token: string, name: string, args: Record<string, unknown>): Promise<McpToolCall> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) return { status: response.status, json: null };
  const data = raw.split("\n").find((line) => line.startsWith("data:"));
  const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
  const result = isRecord(frame) ? frame.result : null;
  if (isRecord(result) && result.structuredContent !== undefined) return { status: response.status, json: result.structuredContent };
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const text = content.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("");
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: text }; }
}

export interface ClaimableWorkspace { bootstrapId: string; assertion: string }

/** An agent with no account provisions a workspace someone can claim later, and keeps its assertion. */
export async function bootstrapClaimableWorkspace(den: DenRef, workspaceName: string): Promise<ClaimableWorkspace> {
  const created = await denFetch(den, "/v1/bootstrap/workspace", { method: "POST", body: JSON.stringify({ workspaceName, claimRoles: ["owner"] }) });
  if (created.response.status !== 200 || !isRecord(created.body)) throw new Error(`Workspace bootstrap failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  return { bootstrapId: stringField(created.body.setup, "id"), assertion: stringField(created.body.identity, "assertion") };
}

/** RFC 7523 JWT-bearer exchange of the agent's assertion at Den's token endpoint. */
export async function exchangeAgentAssertion(den: DenRef, assertion: string): Promise<{ status: number; accessToken: string; scope: string; error: string }> {
  const result = await denFetch(den, "/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const field = (key: string) => isRecord(result.body) && typeof result.body[key] === "string" ? result.body[key] : "";
  return { status: result.response.status, accessToken: field("access_token"), scope: field("scope"), error: field("error") };
}

/** The agent asks for the code and link it hands the person who will claim the workspace. */
export async function requestWorkspaceClaimCode(den: DenRef, workspace: ClaimableWorkspace): Promise<{ userCode: string; verificationUrl: string }> {
  const result = await denFetch(den, `/v1/bootstrap/workspace/${workspace.bootstrapId}/claim`, { method: "POST", headers: { authorization: `Bearer ${workspace.assertion}` } });
  return { userCode: stringField(result.body, "user_code"), verificationUrl: stringField(result.body, "verification_uri_complete") };
}

/** The agent polls whether its workspace has been claimed. */
export async function readWorkspaceClaim(den: DenRef, workspace: ClaimableWorkspace): Promise<{ status: number; state: string; reconciled: boolean }> {
  const result = await denFetch(den, `/v1/bootstrap/workspace/${workspace.bootstrapId}/claim`, { headers: { authorization: `Bearer ${workspace.assertion}` } });
  const body = isRecord(result.body) ? result.body : {};
  return { status: result.response.status, state: typeof body.state === "string" ? body.state : "", reconciled: body.reconciled === true };
}

function bearerFor(session: DenSession, organizationId?: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, ...(organizationId ? { "x-openwork-org-id": organizationId } : {}) };
}
