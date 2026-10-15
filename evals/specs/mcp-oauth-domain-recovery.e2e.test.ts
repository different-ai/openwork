import { expect } from "vitest";
import { denFetch, mcpMock, needs, queryDenDatabase, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

for (const source of ["dynamic", "pre-registered"] as const) {
  test(`an admin reconnects a ${source} MCP client after a self-hosted domain change without recreating the connection`, { timeout: 300_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    await using den = await server({
      place, web: false,
      env: { DEN_FEATURE_MCP_OAUTH_DOMAIN_RECOVERY: "true" },
      mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: false }) },
      org: { name: `Domain recovery ${Date.now()}`, members: { reader: {} } },
    });
    if (!den.database) throw new Error("An isolated database is required");
    const provider = den.mocks.connector;
    const headers = { authorization: `Bearer ${den.admin.token}` };
    const created = await denFetch(den.admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Self-hosted connector", url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
    });
    expect(created.response.status, created.text).toBe(200);
    const id = text(record(created.body).id);
    const path = `/v1/mcp-connections/${id}`;
    const initial = await denFetch(den.admin, `${path}/connect/start`, { headers });
    expect(initial.response.status, initial.text).toBe(200);
    const initialUrl = new URL(text(record(initial.body).authorizeUrl));
    const currentCallback = text(initialUrl.searchParams.get("redirect_uri"));
    const oldCallback = "https://old.example.test/v1/mcp-connections/oauth/callback";

    // Arrange a persisted registration made on a former deployment origin.
    // Dynamic clients are really registered with the provider at the old URL.
    // For pre-registration the provider already allows the new URL (the admin's
    // console change), while Den still requires the admin to save confirmation.
    if (source === "dynamic") {
      const registration = await fetch(`${provider.url}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Self-hosted client", redirect_uris: [oldCallback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      expect(registration.ok).toBe(true);
      const oldClient = record(await registration.json());
      await queryDenDatabase(den.database.url,
        "UPDATE org_oauth_client SET client_id = ?, extra = ? WHERE provider_id = ?",
        [text(oldClient.client_id), JSON.stringify({ enterpriseMcpRegistrationSource: source, clientInformation: oldClient, registeredRedirectUri: oldCallback, registrationContractVersion: 2 }), id]);
    } else {
      const details = record((await denFetch(den.admin, path, { headers })).body);
      const configured = await denFetch(den.admin, path, {
        method: "PUT", headers,
        body: JSON.stringify({ name: details.name, url: details.url, authType: "oauth", credentialMode: "shared", expectedUpdatedAt: details.updatedAt, access: details.access, oauthClient: { clientId: details.oauthClientId, clientSecret: "synthetic-provider-secret", tokenEndpointAuthMethod: "client_secret_post" } }),
      });
      expect(configured.response.status, configured.text).toBe(200);
      await queryDenDatabase(den.database.url,
        "UPDATE org_oauth_client SET extra = JSON_SET(extra, '$.registeredRedirectUri', ?, '$.enterpriseMcpRegistrationSource', ?) WHERE provider_id = ?",
        [oldCallback, source, id]);
    }
    const policy = await denFetch(den.admin, `${path}/tool-policy`, { method: "PUT", headers, body: JSON.stringify({ allDisabled: false, disabledTools: ["blocked_example_tool"] }) });
    expect(policy.response.status, policy.text).toBe(200);
    const before = await queryDenDatabase(den.database.url, "SELECT id, client_id, client_secret FROM org_oauth_client WHERE provider_id = ?", [id]);
    const connectionBefore = await queryDenDatabase(den.database.url, "SELECT tool_policy FROM external_mcp_connection WHERE id = ?", [id]);
    const grantsBefore = await queryDenDatabase(den.database.url, "SELECT id FROM external_mcp_connection_access_grant WHERE external_mcp_connection_id = ?", [id]);
    evidence.recordAssertionEvidence("given a connection registered on the former public domain", `The persisted callback is ${oldCallback}; source ${source}; connection settings and direct grants are recorded before reconnect.`, true);

    const unauthorized = await denFetch(den.members.reader, `${path}/connect/start`, { headers: { authorization: `Bearer ${den.members.reader.token}` } });
    expect(unauthorized.response.status).toBe(403);
    evidence.recordAssertionEvidence("a member cannot replace the organization's shared registration", "Shared reconnect returned HTTP 403 for the non-admin member.", true);

    const started = await denFetch(den.admin, `${path}/connect/start`, { headers });
    if (source === "pre-registered") {
      expect(started.response.status, started.text).toBe(409);
      expect(record(started.body).callbackUrl).toBe(currentCallback);
      expect(record(started.body).message).toContain("provider's developer console");
      expect(await queryDenDatabase(den.database.url, "SELECT id, client_id, client_secret FROM org_oauth_client WHERE provider_id = ?", [id])).toEqual(before);
      const details = await denFetch(den.admin, path, { headers });
      const connection = record(details.body);
      const saved = await denFetch(den.admin, path, {
        method: "PUT", headers,
        body: JSON.stringify({ name: connection.name, url: connection.url, authType: "oauth", credentialMode: "shared", expectedUpdatedAt: connection.updatedAt, access: connection.access, oauthClient: { clientId: text(record(before[0]).client_id) } }),
      });
      expect(saved.response.status, saved.text).toBe(200);
      evidence.recordAssertionEvidence("when the admin confirms the provider callback update", `Reconnect first returned HTTP 409 with ${currentCallback}; saving the same client ID returned HTTP ${saved.response.status}, without automatic registration.`, true);
    } else {
      expect(started.response.status, started.text).toBe(200);
      const authorize = new URL(text(record(started.body).authorizeUrl));
      expect(authorize.searchParams.get("redirect_uri")).toBe(currentCallback);
      expect(authorize.searchParams.get("client_id")).not.toBe(record(before[0]).client_id);
      evidence.recordAssertionEvidence("when the admin reconnects the dynamic client", `A replacement client was registered and authorization uses ${currentCallback}, not the obsolete origin.`, true);
    }
    const ready = source === "dynamic" ? started : await denFetch(den.admin, `${path}/connect/start`, { headers });
    expect(ready.response.status, ready.text).toBe(200);
    const authorize = new URL(text(record(ready.body).authorizeUrl));
    expect(authorize.searchParams.get("redirect_uri")).toBe(currentCallback);
    const tokenRequestsBefore = (await provider.requests()).filter((request) => request.path === "/token").length;
    const obsoleteApproval = await fetch(initialUrl, { redirect: "manual" });
    expect(obsoleteApproval.status).toBe(302);
    const obsoleteCallback = await fetch(text(obsoleteApproval.headers.get("location")), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(obsoleteCallback.ok).toBe(false);
    expect((await provider.requests()).filter((request) => request.path === "/token")).toHaveLength(tokenRequestsBefore);
    evidence.recordAssertionEvidence("an authorization begun before the registration changed cannot exchange a code", "The obsolete callback was rejected before any token request reached the provider.", true);
    const approval = await fetch(authorize, { redirect: "manual" });
    expect(approval.status).toBe(302);
    const completed = await fetch(text(approval.headers.get("location")), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(completed.status, await completed.text()).toBe(200);
    const tools = await denFetch(den.admin, `${path}/tools`, { headers });
    expect(tools.response.status, tools.text).toBe(200);
    expect(await queryDenDatabase(den.database.url, "SELECT tool_policy FROM external_mcp_connection WHERE id = ?", [id])).toEqual(connectionBefore);
    expect(await queryDenDatabase(den.database.url, "SELECT id FROM external_mcp_connection_access_grant WHERE external_mcp_connection_id = ?", [id])).toEqual(grantsBefore);
    const after = await queryDenDatabase(den.database.url, "SELECT id, client_id, client_secret, JSON_UNQUOTE(JSON_EXTRACT(extra, '$.registeredRedirectUri')) AS callback FROM org_oauth_client WHERE provider_id = ?", [id]);
    expect(record(after[0]).id).toBe(record(before[0]).id);
    expect(record(after[0]).callback).toBe(currentCallback);
    if (source === "pre-registered") {
      expect(record(after[0]).client_id).toBe(record(before[0]).client_id);
      expect(record(before[0]).client_secret).toBeTruthy();
      expect(record(after[0]).client_secret).toBe(record(before[0]).client_secret);
    }
    evidence.recordAssertionEvidence("after: provider consent and code exchange succeed with the new callback", `Callback HTTP ${completed.status}; authenticated tools HTTP ${tools.response.status}; registration row, connection, tool policy and grant IDs preserved.`, true);

    if (source === "dynamic") {
      // A second drift with a still-usable access token must not disrupt work.
      await queryDenDatabase(den.database.url, "UPDATE org_oauth_client SET extra = JSON_SET(extra, '$.registeredRedirectUri', ?) WHERE provider_id = ?", [oldCallback, id]);
      const workingRegistration = await queryDenDatabase(den.database.url, "SELECT client_id, extra FROM org_oauth_client WHERE provider_id = ?", [id]);
      const workingCredential = await queryDenDatabase(den.database.url, "SELECT access_token, refresh_token FROM external_mcp_connection WHERE id = ?", [id]);
      const reused = await denFetch(den.admin, `${path}/connect/start`, { headers });
      expect(record(reused.body).status, reused.text).toBe("connected");
      expect(await queryDenDatabase(den.database.url, "SELECT client_id, extra FROM org_oauth_client WHERE provider_id = ?", [id])).toEqual(workingRegistration);
      expect(await queryDenDatabase(den.database.url, "SELECT access_token, refresh_token FROM external_mcp_connection WHERE id = ?", [id])).toEqual(workingCredential);
      evidence.recordAssertionEvidence("working credentials survive origin drift until authorization is needed", "Connect reused the working access token; the old registration and both encrypted token columns remained unchanged.", true);

      // A second identity's persisted credentials witness that client-wide
      // replacement clears refresh grants, not access tokens or account rows.
      await queryDenDatabase(den.database.url,
        "INSERT INTO connected_account (id, organization_id, org_membership_id, provider_id, access_token, refresh_token, scopes) SELECT ?, organization_id, created_by_org_membership_id, id, access_token, refresh_token, JSON_ARRAY('mcp:read') FROM external_mcp_connection WHERE id = ?", ["ca_domain_recovery_fixture", id]);
      const accountBefore = await queryDenDatabase(den.database.url, "SELECT id, access_token, scopes FROM connected_account WHERE provider_id = ?", [id]);
      // The mock rejects access tokens while refresh replies would be held.
      // Correct migration must never send an old refresh grant with a new client.
      await provider.holdRefreshResponses();
      const restarted = await denFetch(den.admin, `${path}/connect/start`, { headers });
      expect(restarted.response.status, restarted.text).toBe(200);
      expect(record(restarted.body).status).toBe("needs_auth");
      const held = await provider.pendingRefreshResponses();
      for (const response of held) await provider.releaseRefreshResponse(response.id);
      expect(held).toHaveLength(0);
      expect(await queryDenDatabase(den.database.url, "SELECT id, access_token, scopes FROM connected_account WHERE provider_id = ?", [id])).toEqual(accountBefore);
      const oldRefreshes = await queryDenDatabase(den.database.url, "SELECT refresh_token, pending_code_verifier FROM connected_account WHERE provider_id = ?", [id]);
      expect(record(oldRefreshes[0])).toMatchObject({ refresh_token: null, pending_code_verifier: null });
      evidence.recordAssertionEvidence("replacement does not reuse another identity's obsolete refresh grant", "A new authorize URL was issued; zero refresh grants reached the provider; the account ID, access token and scopes survived while its old refresh grant was removed.", true);
    }
  });
}

test("an admin keeps the previous MCP registration when the provider refuses the new callback", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    env: { DEN_FEATURE_MCP_OAUTH_DOMAIN_RECOVERY: "true" },
    mocks: { connector: mcpMock({ rejectDynamicRedirectUris: "invalid_redirect_uri" }) },
    org: { name: `Domain recovery refusal ${Date.now()}`, members: {} },
  });
  if (!den.database) throw new Error("An isolated database is required");
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const created = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Self-hosted connector", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "shared", oauthClient: { clientId: "former-registration" }, access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBe(200);
  const id = text(record(created.body).id);
  await queryDenDatabase(den.database.url,
    "UPDATE org_oauth_client SET extra = JSON_SET(extra, '$.registeredRedirectUri', 'https://old.example.test/v1/mcp-connections/oauth/callback', '$.enterpriseMcpRegistrationSource', 'dynamic') WHERE provider_id = ?", [id]);
  const before = await queryDenDatabase(den.database.url, "SELECT id, client_id, client_secret, extra FROM org_oauth_client WHERE provider_id = ?", [id]);
  expect(before).toHaveLength(1);
  const seeded = await queryDenDatabase(den.database.url, "SELECT JSON_UNQUOTE(JSON_EXTRACT(extra, '$.registeredRedirectUri')) AS callback, JSON_UNQUOTE(JSON_EXTRACT(extra, '$.enterpriseMcpRegistrationSource')) AS source FROM org_oauth_client WHERE provider_id = ?", [id]);
  expect(record(seeded[0])).toMatchObject({ callback: "https://old.example.test/v1/mcp-connections/oauth/callback", source: "dynamic" });
  evidence.recordAssertionEvidence("given a provider that refuses registration on the new public domain", "The provider advertises DCR but rejects new callbacks with invalid_redirect_uri; a former registration remains saved.", true);
  const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
  expect(started.response.status, started.text).toBe(424);
  expect(record(started.body).error).toBe("oauth_handshake_failed");
  expect(record(started.body).callbackUrl).not.toContain("old.example.test");
  const registrations = (await den.mocks.connector.requests()).filter((request) => request.path === "/register");
  expect(registrations.some((request) => request.status === 400)).toBe(true);
  evidence.recordAssertionEvidence("when the admin reconnects, provider refusal is not treated as success", "The provider returned HTTP 400; Connect returned HTTP 424 with the active callback and no authorize URL.", true);
  expect(await queryDenDatabase(den.database.url, "SELECT id, client_id, client_secret, extra FROM org_oauth_client WHERE provider_id = ?", [id])).toEqual(before);
  evidence.recordAssertionEvidence("after: the previous client remains available without recreating the connection", "Registration ID, client ID, secret column and metadata are byte-for-byte unchanged after the refused replacement.", true);
});
