import { denFetch, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

const TOOL = "lookup_record";

function stringField(value: unknown, key: string, label: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key} in ${label}`);
  return field;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export type ScriptOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string; kind: string; message: string; toolCalls: number };

/**
 * An organization whose member's agent runs OpenWork Cloud scripts against one
 * no-sign-in MCP tool. The mock serves every call and records it, so the spec
 * counts what actually reached the provider, not what the script claims.
 */
export async function cloudScriptToolCalls(seed: Seed) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Cloud script tool calls ${runId}`;
  const den = await seed.den({
    web: false,
    org: { name: orgName, members: { member: {} } },
    mocks: {
      records: seed.mock({
        allowUnauthenticatedMcp: true,
        tools: [{
          name: TOOL,
          description: "Look up one customer record by its number",
          inputSchema: { type: "object", properties: { number: { type: "number" } } },
          result: { content: [{ type: "text", text: "record found" }] },
        }],
      }),
    },
  });
  const member = den.members.member;
  const mock = den.mocks.records;
  if (!member || !mock) throw new Error("The member or the MCP mock was not provisioned");

  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const orgId = records(isRecord(orgs.body) ? orgs.body.orgs : null).find((org) => org.name === orgName)?.id;
  if (typeof orgId !== "string") throw new Error(`Test organization not found: HTTP ${orgs.response.status}`);
  const call = async (session: DenSession, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    headers.set("x-openwork-org-id", orgId);
    return denFetch(session, path, { ...init, headers });
  };

  const added = await call(den.admin, `/v1/mcp-connections/by-key/records-${runId}`, {
    method: "PUT",
    body: JSON.stringify({ name: "Customer records", url: mock.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  if (added.response.status !== 201) throw new Error(`Adding the connection: HTTP ${added.response.status} ${added.text.slice(0, 500)}`);
  const connectionId = stringField(added.body, "id", "connection");

  const minted = await call(member, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  if (minted.response.status !== 200) throw new Error(`Minting the member's MCP token: HTTP ${minted.response.status} ${minted.text.slice(0, 500)}`);
  const token = stringField(minted.body, "token", "member token");

  let rpcId = 0;
  /** The member's agent calls one OpenWork Cloud MCP tool with its own token. */
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(200_000),
    });
    const raw = await response.text();
    if (response.status !== 200) throw new Error(`MCP ${name}: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
    if (!isRecord(frame) || !isRecord(frame.result)) throw new Error(`MCP ${name} returned no result: ${raw.slice(0, 500)}`);
    return frame.result;
  };

  return {
    den,
    tool: TOOL,
    /** The exact script path search_capabilities gives the agent for the record lookup. */
    async scriptPath(): Promise<string> {
      const found = await callTool("search_capabilities", { query: "look up customer record", type: "mcp", limit: 10 });
      const match = records(isRecord(found.structuredContent) ? found.structuredContent.matches : null)
        .find((entry) => entry.name === `mcp:${connectionId}:${TOOL}`);
      return typeof match?.scriptPath === "string" ? match.scriptPath : "";
    },
    /** One ad-hoc script run through execute_capability_script. */
    async runScript(code: string): Promise<ScriptOutcome> {
      const result = await callTool("execute_capability_script", { code });
      if (result.isError !== true && isRecord(result.structuredContent)) return { ok: true, value: result.structuredContent.value };
      const text = records(result.content).map((part) => typeof part.text === "string" ? part.text : "").join("");
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* provider text */ }
      const field = (key: string) => isRecord(body) && typeof body[key] === "string" ? body[key] : "";
      const calls = isRecord(body) && Array.isArray(body.toolCalls) ? body.toolCalls.length : 0;
      return { ok: false, error: field("error") || text.slice(0, 500), kind: field("kind"), message: field("message"), toolCalls: calls };
    },
    /** Calls the provider actually served since `sinceIso`. */
    async served(sinceIso: string): Promise<number> {
      return (await mock.toolCalls({ name: TOOL, sinceIso })).length;
    },
  };
}
