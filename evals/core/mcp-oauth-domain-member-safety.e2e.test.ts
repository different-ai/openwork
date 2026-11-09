import { expect } from "vitest";
import { denFetch, mcpMock, queryDenDatabase, server, test } from "@openwork/testkit";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string"); return value; }

test("a member cannot replace a shared OAuth client or invalidate another member's refresh grant after domain migration", { timeout: 300_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, web: false, env: { DEN_FEATURE_MCP_OAUTH_DOMAIN_RECOVERY: "true" }, mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: false }) }, org: { name: "Migration member safety", members: { member: {} } } });
  if (!den.database) throw new Error("Isolated database required");
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const memberHeaders = { authorization: `Bearer ${den.members.member.token}` };
  const created = await denFetch(den.admin, "/v1/mcp-connections", { headers, method: "POST", body: JSON.stringify({ name: "Member migration lab", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }) });
  expect(created.response.status, created.text).toBe(200);
  const id = text(object(created.body).id); const path = `/v1/mcp-connections/${id}/connect/start`;
  const start = await denFetch(den.admin, path, { headers });
  expect(start.response.status, start.text).toBe(200);
  const approval = await fetch(text(object(start.body).authorizeUrl), { redirect: "manual" });
  const complete = await fetch(text(approval.headers.get("location")), { redirect: "manual" });
  expect(complete.status).toBe(200);
  const pending = await denFetch(den.members.member, path, { headers: memberHeaders });
  expect(pending.response.status, pending.text).toBe(200);
  await queryDenDatabase(den.database.url, "UPDATE org_oauth_client SET extra = JSON_SET(extra, '$.registeredRedirectUri', 'https://old.example.test/v1/mcp-connections/oauth/callback') WHERE provider_id = ?", [id]);
  const registrationBefore = await queryDenDatabase(den.database.url, "SELECT id, client_id, extra FROM org_oauth_client WHERE provider_id = ?", [id]);
  const accountsBefore = await queryDenDatabase(den.database.url, "SELECT id, access_token, refresh_token, pending_code_verifier FROM connected_account WHERE provider_id = ? ORDER BY id", [id]);
  expect(accountsBefore.some(account => Boolean(object(account).refresh_token))).toBe(true);
  const requestsBefore = (await den.mocks.connector.requests()).length;
  const denied = await denFetch(den.members.member, path, { headers: memberHeaders });
  expect(denied.response.status, denied.text).toBe(409);
  expect(object(denied.body).message).toContain("organization admin must reconnect");
  expect(await queryDenDatabase(den.database.url, "SELECT id, client_id, extra FROM org_oauth_client WHERE provider_id = ?", [id])).toEqual(registrationBefore);
  expect(await queryDenDatabase(den.database.url, "SELECT id, access_token, refresh_token, pending_code_verifier FROM connected_account WHERE provider_id = ? ORDER BY id", [id])).toEqual(accountsBefore);
  expect((await den.mocks.connector.requests()).length).toBe(requestsBefore);
  evidence.recordAssertionEvidence("a member's recovery attempt leaves everyone's saved sign-ins intact", `member Connect HTTP ${denied.response.status}; provider requests added=0; registration and all encrypted access/refresh/PKCE columns unchanged`, true);
});
