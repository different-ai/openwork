import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
export function items(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected list");
  return value.map(record);
}
export function expression(match: Record<string, unknown> | undefined): string {
  return text(match?.signature).split("(input:")[0];
}
export function toolPayload(result: Record<string, unknown>) {
  return result.structuredContent === undefined
    ? record(JSON.parse(text(items(result.content)[0]?.text))) : record(result.structuredContent);
}
export type Persona = "owner" | "teammate" | "outsider" | "withoutBilling";

// Synthetic source tables, never a precomputed task answer. Shared credentials
// are intentional: connection grants, not per-member OAuth, are under test.
function billingTools(settled: boolean): MockMcpTool[] {
  const invoices = [
    { id: "INV-101", account: "Account A", due: "2026-09-01", amount: 500 },
    { id: "INV-102", account: "Account B", due: "2026-09-10", amount: 900 },
    { id: "INV-103", account: "Account C", due: "2026-09-30", amount: 1200 },
  ];
  const payments = [
    { invoiceId: "INV-101", amount: 500 }, { invoiceId: "INV-102", amount: 100 },
    ...(settled ? [{ invoiceId: "INV-102", amount: 800 }] : []),
  ];
  return [
    { name: "list_invoices", description: "Read billing invoices with account, due date and amount", rows: { invoices } },
    { name: "list_payments", description: "Read billing payments by invoice ID and amount", rows: { payments } },
  ].map(({ name, description, rows }): MockMcpTool => ({
    name, description, inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    result: { content: [{ type: "text", text: JSON.stringify(rows) }], structuredContent: rows },
  }));
}
function requireStatus(response: Response, expected: number) {
  if (response.status !== expected) throw new Error(`Expected HTTP ${expected}, received ${response.status}`);
}
export async function codeModeOrgOptIn(seed: Seed) {
  const den = await seed.den({ web: true,
    env: { OPENWORK_EVAL_MYSQL8: "1", DEN_CODE_MODE_OPT_IN_ENABLED: "true" },
    org: { name: "Invoice follow-up proof", admin: { name: "Workspace owner" }, members: {
      teammate: { name: "Billing teammate" }, outsider: { name: "Outside-team member" },
      withoutBilling: { name: "Teammate without billing access" },
    } }, mocks: { billing: seed.mock({ allowUnauthenticatedMcp: true, tools: billingTools(false) }) },
  });
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const organizationId = text(record(org.organization).id);
  const memberId = (email: string) => text(items(org.members).find((entry) => text(record(entry.user).email).toLowerCase() === email.toLowerCase())?.id);
  const connection = await seed.orgConnection(den.admin, {
    name: "Billing records", url: den.mocks.billing.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: false },
  });
  const grant = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/access`, { method: "PUT",
    body: JSON.stringify({ access: { orgWide: false, memberIds: [den.admin, den.members.teammate, den.members.outsider].map((session) => memberId(session.email)), teamIds: [] } }) });
  requireStatus(grant.response, 200);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST",
    body: JSON.stringify({ name: "Billing team", memberIds: [memberId(den.members.teammate.email), memberId(den.members.withoutBilling.email)] }) });
  requireStatus(team.response, 201);
  const teamId = text(record(record(team.body).team).id);
  const plugin = await seed.api(den.admin, "/v1/plugins", { method: "POST", body: JSON.stringify({ name: "Billing procedures", orgWide: false }) });
  requireStatus(plugin.response, 201);
  const pluginId = text(record(record(plugin.body).item).id);
  const sessions = { owner: den.admin, teammate: den.members.teammate, outsider: den.members.outsider, withoutBilling: den.members.withoutBilling };
  const tokenFor = async (session: typeof den.admin) => {
    const response = await seed.api(session, "/v1/mcp/token", { method: "POST",
      headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    requireStatus(response.response, 200);
    return text(record(response.body).token);
  };
  const tokens = { owner: await tokenFor(sessions.owner), teammate: await tokenFor(sessions.teammate),
    outsider: await tokenFor(sessions.outsider), withoutBilling: await tokenFor(sessions.withoutBilling) };
  let requestId = 0;
  // Protocol client; no simulated chat, model, or private credential in evidence.
  const rpc = async (method: string, params: Record<string, unknown> = {}, caller: Persona = "owner") => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST",
      headers: { authorization: `Bearer ${tokens[caller]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(60_000) });
    requireStatus(response, 200);
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : raw));
    if (message.error !== undefined) throw new Error(`MCP ${method} failed: ${JSON.stringify(message.error)}`);
    return record(message.result);
  };
  const script = async (code: string, caller: Persona = "owner") => {
    const result = await rpc("tools/call", { name: "execute_capability_script", arguments: { code } }, caller);
    if (result.isError === true) throw new Error(`MCP script failed: ${JSON.stringify(result)}`);
    return toolPayload(result).value;
  };
  // Security denial attempts, not positive product transitions bypassing UI.
  const attempt = (caller: Persona, path: string, body: Record<string, unknown>, method = "POST") => denFetch(sessions[caller], path, {
    method, headers: { authorization: `Bearer ${sessions[caller].token}` }, body: JSON.stringify(body),
  });
  const settleInvoice = async () => {
    // Change external records only; do not seed the Workflow, snapshot or answer.
    const response = await fetch(`${den.mocks.billing.url}/admin/tools`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: billingTools(true) }), signal: AbortSignal.timeout(15_000) });
    requireStatus(response, 200);
  };
  const viewport = { width: 1280, height: 960 };
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/org-settings", headless: true, viewport });
  const teammateWeb = await seed.web({ den, signedInAs: "teammate", startPath: "/dashboard/library", headless: true, viewport });
  const outsiderWeb = await seed.web({ den, signedInAs: "outsider", startPath: "/dashboard/library", headless: true, viewport });
  const withoutBillingWeb = await seed.web({ den, signedInAs: "withoutBilling", startPath: "/dashboard/library", headless: true, viewport });
  return { den, web, teammateWeb, outsiderWeb, withoutBillingWeb, rpc, script, attempt, settleInvoice, connection, pluginId, teamId };
}
