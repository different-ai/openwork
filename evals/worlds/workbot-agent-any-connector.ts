import { createServer } from "node:http";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { chatAs } from "./workbot-agent-library.ts";
import { ENCRYPTION_KEY, SLACK_CONNECTION_ID, encryptForDen } from "./workbot-proactive.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FixtureTool = { name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

/**
 * Ten fictional custom MCP connectors, each with the tools its server lists, annotations as the server sets them: reads
 * labelled read-only, reads without labels, writes labelled, mislabelled and unlabelled, and destructive ones.
 * Brightwater Ledger lists only writes.
 */
export const ANY_CONNECTOR_FIXTURES: { slug: string; name: string; tools: FixtureTool[] }[] = [
  { slug: "desk", name: "Lumen Support Desk", tools: [
    { name: "list_tickets", description: "List tickets assigned or escalated to you.", annotations: { readOnlyHint: true } },
    { name: "get_ticket", description: "Read one ticket with its updates." },
    { name: "ticket_report", description: "Weekly ticket volume by queue." },
    { name: "close_ticket", description: "Close a ticket.", annotations: { readOnlyHint: true } },
    { name: "reply_to_customer", description: "Reply to the customer on a ticket.", annotations: { readOnlyHint: false } },
    { name: "purge_queue", description: "Remove every ticket in a queue.", annotations: { readOnlyHint: true, destructiveHint: true } },
  ] },
  { slug: "ledger", name: "Brightwater Ledger", tools: [
    { name: "post_entry", description: "Post a journal entry." },
    { name: "approve_payment", description: "Approve a pending payment.", annotations: { readOnlyHint: false } },
    { name: "void_invoice", description: "Void an invoice.", annotations: { destructiveHint: true } },
  ] },
  { slug: "crm", name: "Northwind CRM", tools: [
    { name: "search_contacts", description: "Search contacts by name or company.", annotations: { readOnlyHint: true } },
    { name: "get_deal", description: "Read one deal.", annotations: { readOnlyHint: true } },
    { name: "update_deal", description: "Change a deal's stage or amount.", annotations: { readOnlyHint: false } },
  ] },
  { slug: "wiki", name: "Fabrikam Wiki", tools: [
    { name: "search_pages", description: "Search wiki pages." },
    { name: "read_page", description: "Read one page." },
    { name: "edit_page", description: "Edit a page." },
  ] },
  { slug: "deploys", name: "Tailspin Deploys", tools: [
    { name: "list_deploys", description: "List recent deploys.", annotations: { readOnlyHint: true } },
    { name: "trigger_deploy", description: "Start a deploy.", annotations: { readOnlyHint: false } },
    { name: "rollback", description: "Roll back the last deploy.", annotations: { destructiveHint: true } },
  ] },
  { slug: "status", name: "Contoso Status", tools: [{ name: "get_status", description: "Current service status.", annotations: { readOnlyHint: true } }] },
  { slug: "recruiting", name: "Halcyon Recruiting", tools: [
    { name: "list_candidates", description: "Candidates in your open roles.", annotations: { readOnlyHint: true } },
    { name: "schedule_interview", description: "Schedule an interview." },
  ] },
  { slug: "analytics", name: "Juniper Analytics", tools: [
    { name: "list_dashboards", description: "List dashboards.", annotations: { readOnlyHint: true } },
    { name: "run_query", description: "Run a SQL query." },
  ] },
  { slug: "docs", name: "Meridian Docs", tools: [
    { name: "fetch_document", description: "Fetch a document.", annotations: { readOnlyHint: true } },
    { name: "share_document", description: "Share a document with someone." },
  ] },
  { slug: "roadmaps", name: "Orbit Roadmaps", tools: [
    { name: "list_initiatives", description: "List roadmap initiatives.", annotations: { readOnlyHint: true } },
    { name: "get_initiative", description: "Read one initiative." },
  ] },
];

/** A disposable MCP provider on loopback: each connector's tools at /mcp/<slug>, answered without credentials. */
async function fixtureProvider() {
  const calls: { slug: string; tool: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const slug = (req.url ?? "").split("/").at(-1) ?? "";
    const fixture = ANY_CONNECTOR_FIXTURES.find((entry) => entry.slug === slug);
    if (!fixture) return void res.writeHead(404).end();
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    let rpc: unknown;
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString() || "null");
    } catch {
      return void res.writeHead(400).end();
    }
    if (!isRecord(rpc) || !("id" in rpc)) return void res.writeHead(202).end();
    const answer = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    };
    if (rpc.method === "initialize") return answer({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: fixture.slug, version: "1" } });
    if (rpc.method === "tools/list") return answer({ tools: fixture.tools.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } })) });
    if (rpc.method === "tools/call") {
      const tool = isRecord(rpc.params) && typeof rpc.params.name === "string" ? rpc.params.name : "";
      calls.push({ slug, tool });
      return answer({ content: [{ type: "text", text: `${fixture.name}: ${tool} ok` }] });
    }
    return answer({});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture provider port");
  return {
    url: (slug: string) => `http://127.0.0.1:${address.port}/mcp/${slug}`,
    calls,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Any connected connector as a source of Your agent (`workbotAgentBrief`): Den with Workbot (a runner that only answers
 * health checks), the Workbot Slack app (synthetic credentials), Google Workspace and Slack, and ten custom MCP
 * connectors on a loopback provider, all shared with everyone. Nothing is due, so no model runs. Fictional names only.
 */
export async function workbotAgentAnyConnectorWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const provider = stack.use(await fixtureProvider());
    const den = await seed.den({
      org: { name: "Acme Robotics", admin: { name: "Dana Ortiz" }, members: { member: { name: "Sam Rivera" } } },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_DB_ENCRYPTION_KEY: ENCRYPTION_KEY,
        DEN_ALLOW_PRIVATE_MCP_URLS: "1",
      },
    });
    const organizationId = await seededOrganizationId(seed, den.admin);
    const headers = (session: DenSession) => ({ authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId, "content-type": "application/json" });
    const brief = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", headers: headers(den.admin), body: JSON.stringify({ capabilities: { workbotAgentBrief: true } }) });
    if (!brief.response.ok) throw new Error(`Turning on workbotAgentBrief failed: ${brief.text.slice(0, 300)}`);
    const enabled = await seed.api(den.admin, "/v1/org/workbot-settings/proactive", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    if (!enabled.response.ok) throw new Error(`Turning on Your agent failed: ${enabled.text.slice(0, 300)}`);

    const ownerContext = await seed.api(den.admin, "/v1/org");
    const ownerMember = isRecord(ownerContext.body) && isRecord(ownerContext.body.currentMember) ? ownerContext.body.currentMember : null;
    const ownerMemberId = typeof ownerMember?.id === "string" ? ownerMember.id : "";
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !ownerMemberId) throw new Error("The fixture needs a disposable testkit database.");
    await seed.nativeConnector(den.admin, {
      providerKey: "google-workspace",
      name: "Google Workspace",
      clientId: "fixture-client.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
      features: ["calendarRead", "gmailDraft", "driveRead"],
      access: { orgWide: true },
    });
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO external_mcp_connection (id, organization_id, name, url, auth_type, credential_mode, created_by_org_membership_id) VALUES (?, ?, 'Slack', 'https://mcp.slack.com/mcp', 'oauth', 'per_member', ?)",
      [SLACK_CONNECTION_ID, organizationId, ownerMemberId],
    );
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO slack_assistant_installation (connection_id, organization_id, enabled, signing_secret, team_id, app_id, bot_user_id, bot_token) VALUES (?, ?, 1, ?, 'T0FIXTURE', 'A0FIXTURE', 'U0WORKBOT', ?)",
      [SLACK_CONNECTION_ID, organizationId, encryptForDen("synthetic-signing-secret"), encryptForDen("xoxb-synthetic-not-a-token")],
    );
    const connections: Record<string, string> = {};
    for (const fixture of ANY_CONNECTOR_FIXTURES) {
      const created = await seed.api(den.admin, "/v1/mcp-connections", {
        method: "POST",
        body: JSON.stringify({ name: fixture.name, url: provider.url(fixture.slug), authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } }),
      });
      const id = isRecord(created.body) && typeof created.body.id === "string" ? created.body.id : "";
      if (!created.response.ok || !id) throw new Error(`Adding ${fixture.name} failed: ${created.text.slice(0, 300)}`);
      connections[fixture.slug] = id;
    }

    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1280, height: 3400, deviceScaleFactor: 1 } });
    const web = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard/library/my-agent", headless: true, viewport: { width: 1280, height: 2600, deviceScaleFactor: 1 } });
    return {
      den,
      owner,
      web,
      organizationId,
      connections,
      /** Calls that reached a connector's server, by connector and tool. */
      providerCalls: provider.calls,
      sayInChat: (name: string, body?: unknown) => chatAs(den.members.member, organizationId, name, body),
      /** ARRANGE: an admin's change to what agents read, as Manage › Workbot saves it. */
      async adminSetsSources(sources: unknown) {
        const saved = await denFetch(den.admin, "/v1/org/workbot-settings/proactive", { method: "PUT", headers: headers(den.admin), body: JSON.stringify({ sources }) });
        if (!saved.response.ok) throw new Error(`Saving what agents read failed: ${saved.text.slice(0, 300)}`);
      },
      async [Symbol.asyncDispose]() {
        await stack.disposeAsync();
      },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
