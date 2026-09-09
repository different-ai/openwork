import { expect } from "vitest";
import { denFetch, freshSession } from "@openwork/behaviors";
import { mcpMock, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

// This is a distinct gateway journey: discovering a blocked connection must be
// informational until the caller explicitly requests connection setup.
test("gateway discovery stays quiet until connection setup is explicitly requested", { timeout: 300_000 }, async ({ evidence, place }) => {
  const orgName = `Connector Search ${Date.now()}`;
  await using den = await server({
    place,
    web: false,
    org: { name: orgName, members: { member: { name: "Connection Member" } } },
    mocks: { connector: mcpMock({ port: 3986 }) },
  });
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(orgs.response.status).toBe(200);
  const orgId = rows(record(orgs.body).orgs).find(org => org.name === orgName)?.id;
  expect(typeof orgId).toBe("string");
  const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": String(orgId) };
  const created = await denFetch(den.admin, "/v1/mcp-connections/by-key/search-intent-notes", {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Notes Search Fixture", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBe(201);
  const connectionId = record(created.body).id;
  const minted = await denFetch(den.admin, "/v1/mcp/token", { method: "POST", headers, body: "{}" });
  expect(minted.response.status).toBe(200);
  const token = record(minted.body).token;
  expect(typeof token).toBe("string");
  let requestId = 0;
  async function search(args: Record<string, unknown>) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name: "search_capabilities", arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const line = raw.split("\n").find(value => value.startsWith("data:"));
    const rpc = record(JSON.parse(line ? line.slice(5) : raw));
    expect(rpc.error).toBeUndefined();
    const result = record(rpc.result);
    expect(result.isError).not.toBe(true);
    const content = rows(result.content);
    const text = content[0]?.text;
    if (typeof text !== "string") throw new Error("Missing search text");
    const payload = record(JSON.parse(text));
    expect(result.structuredContent).toEqual(payload);
    return { result, payload };
  }

  const quiet = await search({ query: "Notes Search Fixture", type: "mcp" });
  expect(rows(quiet.payload.matches).some(match => String(match.name).startsWith(`mcp:${connectionId}:`))).toBe(true);
  expect(quiet.payload.connectionAction).toBeUndefined();
  expect(quiet.payload.connectorCatalog).toBeUndefined();
  expect(quiet.result._meta).toBeUndefined();
  const explicit = await search({ query: "Notes Search Fixture", type: "mcp", intent: "connect" });
  expect(record(explicit.payload.connectionAction).connectionId).toBe(connectionId);
  expect(explicit.payload.connectorCatalog).toBeUndefined();
  evidence.recordAssertionEvidence("Blocked connection discovery stays informational until explicit connect intent", "The same blocked Notes connection appeared in both real gateway searches. Default discovery returned neither action nor catalog nor UI metadata; intent connect returned that connection's action and no unrelated catalog.", true);

  const slackQuiet = await search({ query: "slack" });
  expect(slackQuiet.payload.connectorCatalog).toBeUndefined();
  expect(slackQuiet.payload.connectionAction).toBeUndefined();
  const slack = await search({ query: "slack", intent: "connect" });
  const catalog = record(slack.payload.connectorCatalog);
  expect(catalog.version).toBe(1);
  expect(catalog.selectedIds).toEqual(["slack"]);
  expect(slack.payload.connectionAction).toBeUndefined();
  const entries = rows(catalog.entries);
  const ids = entries.map(entry => entry.id);
  expect(ids).toHaveLength(13);
  expect(new Set(ids).size).toBe(13);
  expect(ids).toEqual(expect.arrayContaining(["slack", "google-workspace", "microsoft-365", "linear"]));
  for (const entry of entries) {
    expect(typeof entry.name).toBe("string");
    const setupUrl = new URL(String(entry.setupUrl));
    expect(["http:", "https:"]).toContain(setupUrl.protocol);
    expect(setupUrl.searchParams.get("quickAdd")).toBe(entry.id);
  }
  evidence.recordAssertionEvidence("Explicit named setup exposes the complete curated catalog without pretending a tool is connected", "Ordinary Slack search returned no setup UI. Explicit connect selected Slack in a versioned 13-entry catalog, including both suites and Linear, with a matching quickAdd setup URL for every entry and no connection action.", true);

  const full = await search({ query: "available services", type: "connectors" });
  const fullCatalog = record(full.payload.connectorCatalog);
  expect(fullCatalog.selectedIds).toEqual([]);
  expect(fullCatalog.entries).toEqual(entries);
  expect(full.payload.matches).toEqual([]);
  expect(full.payload.connectionAction).toBeUndefined();
  evidence.recordAssertionEvidence("Explicit catalog browsing returns all quick adds without selecting or authorizing an account", "type connectors returned all 13 entries, no selected IDs, no executable capability matches, and no connection action.", true);

  let member = den.members.member;
  if (!member) throw new Error("Missing test member");
  const memberHeaders = { authorization: `Bearer ${member.token}`, "x-openwork-org-id": String(orgId) };
  const setup = () => denFetch(member, "/v1/mcp-connections/setup", { method: "POST", headers: memberHeaders, body: JSON.stringify({ query: "resend" }) });
  const deniedSetup = await setup();
  expect(deniedSetup.response.status).toBe(200);
  expect(record(deniedSetup.body).canManage).toBe(false);
  expect(record(deniedSetup.body).members).toEqual([]);
  const memberId = record(deniedSetup.body).memberId;
  const connectionBody = { externalKey: "delegated-setup", name: "Delegated Service", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: false, memberIds: [memberId], teamIds: [] } };
  const createAsMember = () => denFetch(member, "/v1/mcp-connections", { method: "POST", headers: memberHeaders, body: JSON.stringify(connectionBody) });
  expect((await createAsMember()).response.status).toBe(403);
  const role = await denFetch(den.admin, "/v1/roles", { method: "POST", headers, body: JSON.stringify({ roleName: "connection-manager", permission: { mcp_connections: ["manage"] } }) });
  expect(role.response.status, role.text).toBe(201);
  const changeRole = (role: string) => denFetch(den.admin, `/v1/members/${String(memberId)}/role`, { method: "POST", headers, body: JSON.stringify({ role }) });
  expect((await changeRole("connection-manager")).response.status).toBe(200);
  expect([401, 403]).toContain((await setup()).response.status);
  member = await freshSession(member);
  memberHeaders.authorization = `Bearer ${member.token}`;
  const permittedSetup = await setup();
  expect(permittedSetup.response.status, permittedSetup.text).toBe(200);
  expect(record(permittedSetup.body).canManage).toBe(true);
  const delegated = await createAsMember();
  expect(delegated.response.status, delegated.text).toBe(200);
  const delegatedId = String(record(delegated.body).id);
  const resumed = await denFetch(member, "/v1/mcp-connections/setup", { method: "POST", headers: memberHeaders, body: JSON.stringify({ query: den.mocks.connector.mcpUrl, externalKey: "delegated-setup", resumeOnly: true }) });
  expect(rows(record(resumed.body).connections).map(row => row.id)).toEqual([delegatedId]);
  expect((await createAsMember()).response.status).toBe(409);
  const resumedRow = rows(record(resumed.body).connections)[0];
  if (!resumedRow) throw new Error("Missing delegated setup attempt");
  const oauthRepair = await denFetch(member, `/v1/mcp-connections/${delegatedId}`, { method: "PUT", headers: memberHeaders, body: JSON.stringify({ ...connectionBody, expectedUpdatedAt: resumedRow.updatedAt, oauthClient: { clientId: "fixture-client", clientSecret: "fixture-client-secret" } }) });
  expect(oauthRepair.response.status, oauthRepair.text).toBe(200);
  expect(record(oauthRepair.body).id).toBe(delegatedId);
  expect(JSON.stringify(oauthRepair.body)).not.toContain("fixture-client-secret");
  const native = await denFetch(member, "/v1/mcp-connections", { method: "POST", headers: memberHeaders, body: JSON.stringify({ kind: "native_provider", externalKey: "native-setup", nativeProviderKey: "google-workspace", name: "Workspace Google", oauthClient: { clientId: "fixture-google-client" }, access: { orgWide: false, memberIds: [memberId], teamIds: [] } }) });
  expect(native.response.status, native.text).toBe(200);
  const nativeId = record(native.body).id;
  const nativeRepair = await denFetch(member, `/v1/oauth-providers/${String(nativeId)}/client`, { method: "POST", headers: memberHeaders, body: JSON.stringify({ clientId: "replacement-google-client", clientSecret: "replacement-google-secret" }) });
  expect(nativeRepair.response.status, nativeRepair.text).toBe(200);
  expect(record(nativeRepair.body).providerId).toBe(nativeId);
  expect(record(nativeRepair.body).clientId).toBe("replacement-google-client");
  expect(JSON.stringify(nativeRepair.body)).not.toContain("replacement-google-secret");
  evidence.recordAssertionEvidence("A delegated manager can repair external and native OAuth app details on the saved connection", "The existing external edit API and native provider client API accepted replacement client details for the same connection IDs. Responses omitted client secrets; native configuration used synthetic credentials without contacting Google.", true);
  expect((await changeRole("member")).response.status).toBe(200);
  expect([401, 403]).toContain((await createAsMember()).response.status);
  member = await freshSession(member);
  memberHeaders.authorization = `Bearer ${member.token}`;
  expect(record((await setup()).body).canManage).toBe(false);
  expect((await createAsMember()).response.status).toBe(403);
  evidence.recordAssertionEvidence("Connection management permission is enforced server-side and revocation takes effect", "An ordinary member's create request was rejected. A custom role granting only mcp_connections.manage allowed setup and one create. Resuming by key returned that exact row; a duplicate create returned 409. Changing custom roles revoked the old session. After fresh sign-in, revoking the role restored the 403 boundary.", true);

  // The token comes from the controlled MCP witness, never a real provider.
  const tokenResponse = await fetch(`${den.mocks.connector.url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "setup-fixture" }) });
  expect(tokenResponse.status).toBe(200);
  const apiKey = record(await tokenResponse.json()).access_token;
  const keyBody = { externalKey: "api-key-setup", name: "API Key Service", url: den.mocks.connector.mcpUrl, authType: "apikey", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } };
  const invalidKey = await denFetch(den.admin, "/v1/mcp-connections", { method: "POST", headers, body: JSON.stringify({ ...keyBody, apiKey: "invalid-fixture-key" }) });
  expect(invalidKey.response.status).toBe(502);
  const savedKey = await denFetch(den.admin, "/v1/mcp-connections/setup", { method: "POST", headers, body: JSON.stringify({ query: den.mocks.connector.mcpUrl, externalKey: "api-key-setup", resumeOnly: true }) });
  const savedRows = rows(record(savedKey.body).connections);
  expect(savedRows).toHaveLength(1);
  const savedRow = savedRows[0];
  if (!savedRow) throw new Error("Missing API-key setup attempt");
  expect(JSON.stringify(savedKey.body)).not.toContain("invalid-fixture-key");
  const repaired = await denFetch(den.admin, `/v1/mcp-connections/${String(savedRow.id)}`, { method: "PUT", headers, body: JSON.stringify({ ...keyBody, expectedUpdatedAt: savedRow.updatedAt, apiKey }) });
  expect(repaired.response.status, repaired.text).toBe(200);
  const readiness = await denFetch(den.admin, `/v1/mcp-connections/${String(savedRow.id)}/readiness`, { headers });
  expect(record(readiness.body).state).toBe("ready");
  expect(record(repaired.body).id).toBe(savedRow.id);
  expect(JSON.stringify(repaired.body)).not.toContain(String(apiKey));
  evidence.recordAssertionEvidence("An invalid API key can be replaced on the exact saved attempt without exposing credentials", "Initial creation returned 502 but preserved one resumable row. Replacing the key through the existing conditional edit route made the same row ready. Neither setup facts nor the edit response contained the submitted keys.", true);

  const start = () => denFetch(den.admin, `/v1/mcp-connections/${String(connectionId)}/connect/start`, { headers });
  expect((await start()).response.status).toBe(200);
  const restarted = await start();
  expect(restarted.response.status, restarted.text).toBe(200);
  const authorizeUrl = record(restarted.body).authorizeUrl;
  if (typeof authorizeUrl !== "string") throw new Error("Missing restarted OAuth URL");
  const consentUrl = new URL(authorizeUrl);
  consentUrl.searchParams.set("force_consent", "1");
  const consentPage = await fetch(consentUrl);
  const consentHtml = await consentPage.text();
  const action = consentHtml.match(/<form method="post" action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error("Provider approval form is missing");
  const approval = await fetch(new URL(action, consentUrl), { method: "POST", redirect: "manual" });
  expect(approval.status).toBe(302);
  const callbackUrl = approval.headers.get("location");
  if (!callbackUrl) throw new Error("Provider callback is missing");
  const callback = await fetch(callbackUrl);
  const callbackHtml = await callback.text();
  expect(callback.status, callbackHtml).toBe(200);
  const afterRetry = await denFetch(den.admin, `/v1/mcp-connections/${String(connectionId)}/readiness`, { headers });
  expect(record(afterRetry.body).state, JSON.stringify(afterRetry.body)).toBe("ready");
  evidence.recordAssertionEvidence("Restarted OAuth completes with the provider's latest consent transaction", "Two sign-in starts followed by an explicit provider approval completed the Den callback and made the same connection ready.", true);

});
