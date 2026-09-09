import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { eventually, mcpMock, needs, server, test } from "@openwork/testkit";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

for (const issuerSupport of [true, false, undefined]) {
  const metadataLabel = issuerSupport === undefined ? "absent" : String(issuerSupport);

  // This callback journey was missing from the boundary lane: previous coverage
  // used providers that never advertised RFC 9207 response issuer support.
  test(`local OAuth (issuer support ${metadataLabel}) validates callbacks and preserves usable credentials`, { timeout: 120_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    const root = await mkdtemp(join(tmpdir(), "openwork-oauth-issuer-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { handle: provider } = await mcpMock({ authorizationResponseIssuerSupported: issuerSupport }).boot(place);
    const metadata: unknown = await (await fetch(`${provider.url}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })).json();
    expect(metadata).toHaveProperty("issuer", provider.url);
    if (!isRecord(metadata)) throw new Error("Provider metadata missing");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(issuerSupport);
    const token = "synthetic-local-oauth-client";
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
    const server = bootServer({
      ...inherited,
      XDG_CONFIG_HOME: join(root, "config"),
      OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
      OPENWORK_ALLOW_PRIVATE_MCP_URLS: "1",
      OPENWORK_ENCRYPTION_KEY: "synthetic-oauth-vault-key",
    }, token, workspace, () => {});
    try {
      const base = await server.listening;
      const request = (path: string, body?: unknown) => fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const workspaces: unknown = await (await request("/workspaces")).json();
      if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Workspace missing");
      const path = `/workspace/${workspaces.items[0].id}/mcp`;
      const tokenRequests = async () => (await provider.requests()).filter((entry) => entry.path === "/token").length;
      for (const mode of issuerSupport === true ? ["mismatch", "missing", "empty", "state", "valid"] : ["state", "valid"]) {
        const name = `issuer-${mode}`;
        const added = await request(`${path}/managed`, { name, url: provider.mcpUrl });
        const result: unknown = await added.json();
        expect(added.status, JSON.stringify(result)).toBe(201);
        if (!isRecord(result) || typeof result.authorizeUrl !== "string") throw new Error("Authorization URL missing");
        const authorize = new URL(result.authorizeUrl);
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
        const redirect = await fetch(authorize, { redirect: "manual" });
        expect(redirect.status).toBe(302);
        const callback = new URL(redirect.headers.get("location")!);
        expect(callback.searchParams.get("iss")).toBe(issuerSupport === true ? provider.url : null);
        if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
        if (mode === "missing") callback.searchParams.delete("iss");
        if (mode === "empty") callback.searchParams.set("iss", "");
        if (mode === "state") callback.searchParams.set("state", "invalid-state");
        const before = await tokenRequests();
        const completed = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
        const html = await completed.text();
        const connection: unknown = await (await request(`${path}/${name}/managed`)).json();
        if (mode !== "valid") {
          expect(completed.ok, html).toBe(false);
          expect(await tokenRequests()).toBe(before);
          expect(connection).not.toMatchObject({ status: "connected" });
          evidence.recordAssertionEvidence(`Reject ${mode} callback before token exchange`, `HTTP ${completed.status}; zero token requests; connection is not connected.`, true);
        } else {
          expect(completed.status, html).toBe(200);
          expect(html).toContain("Connected");
          expect(connection).toMatchObject({ status: "connected" });
          expect(await tokenRequests()).toBe(before + 1);
          evidence.recordAssertionEvidence(`Sign-in supports ${metadataLabel} issuer-support metadata with PKCE`, "Verified advertised metadata and callback issuer presence; provider required S256 and accepted exactly one code exchange; callback and server report connected.", true);
          const replay = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
          expect(replay.ok).toBe(false);
          expect(await tokenRequests()).toBe(before + 1);
          // Replay currently marks the local status reconnect_required on both dev
          // and this fix. Assert credential usability separately from that inherited defect.
          const reused = await request(`${path}/${name}/managed/connect`, {});
          expect(reused.status).toBe(200);
          expect(await reused.json()).toMatchObject({ status: "connected" });
          expect(await tokenRequests()).toBe(before + 1);
          evidence.recordAssertionEvidence("Replay preserves usable credentials", "Replay rejected without another token exchange; connecting again reused persisted credentials and passed authenticated tool discovery without OAuth.", true);
        }
      }
    } finally {
      await stopChild(server.child);
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Den OAuth (issuer support ${metadataLabel}) validates callbacks and preserves usable credentials`, { timeout: 300_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    await using den = await server({
      place, web: false,
      mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: issuerSupport }) },
      org: { name: `OAuth Issuer ${Date.now()}`, members: {} },
    });
    const provider = den.mocks.connector;
    const metadata: unknown = await (await fetch(`${provider.url}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })).json();
    if (!isRecord(metadata)) throw new Error("Provider metadata missing");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(issuerSupport);
    const headers = { authorization: `Bearer ${den.admin.token}` };
    const credentialMode = issuerSupport === true ? "per_member" : "shared";
    for (const mode of issuerSupport === true ? ["mismatch", "valid"] : ["valid"]) {
      const created = await denFetch(den.admin, "/v1/mcp-connections", {
        method: "POST", headers,
        body: JSON.stringify({ name: `Issuer ${mode}`, url: provider.mcpUrl, authType: "oauth", credentialMode, access: { orgWide: true } }),
      });
      expect(created.response.status, created.text).toBe(200);
      if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
      const id = created.body.id;
      const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
      expect(started.response.status, started.text).toBe(200);
      if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
      const redirect = await fetch(started.body.authorizeUrl, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      const callback = new URL(redirect.headers.get("location")!);
      expect(callback.searchParams.get("iss")).toBe(issuerSupport === true ? provider.url : null);
      if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
      const before = (await provider.requests()).filter((entry) => entry.path === "/token").length;
      const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const html = await completed.text();
      expect(completed.status, html).toBe(mode === "valid" ? 200 : 400);
      expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + (mode === "valid" ? 1 : 0));
      const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
      expect(listed.response.status).toBe(200);
      if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
      const connection = listed.body.connections.find((entry) => isRecord(entry) && entry.id === id);
      expect(connection).toMatchObject({ connected: mode === "valid" });
      evidence.recordAssertionEvidence(
        `Den ${mode === "valid" ? `completes sign-in with ${metadataLabel} issuer-support metadata` : "rejects a mismatched issuer before exchange"}`,
        `Callback returned HTTP ${completed.status}; provider observed ${mode === "valid" ? "exactly one" : "zero"} token requests.`, true,
      );
      if (mode === "valid") {
        const replay = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        expect(replay.status).toBe(400);
        expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + 1);
        const afterReplay = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
        expect(afterReplay.response.status).toBe(200);
        if (!isRecord(afterReplay.body) || !Array.isArray(afterReplay.body.connections)) throw new Error("Connections missing after replay");
        expect(afterReplay.body.connections.find((entry) => isRecord(entry) && entry.id === id)).toMatchObject({ connected: true });
        const reused = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
        expect(reused.response.status, reused.text).toBe(200);
        expect(reused.body).toMatchObject({ status: "connected", authorizeUrl: null });
        expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + 1);
        evidence.recordAssertionEvidence("Den replay preserves usable credentials", "Replay rejected; a subsequent connection check reused saved credentials and remained connected without another token exchange.", true);

        const invalidations = (log: string, message = "external_mcp_credential_invalidated") => log.split(/\r?\n/).flatMap((line) => {
          const start = line.indexOf("{");
          if (start < 0) return [];
          try {
            const value: unknown = JSON.parse(line.slice(start));
            return isRecord(value) && value.message === message && value.connection_id === id ? [value] : [];
          } catch { return []; }
        });
        expect(invalidations(await den.apiLog())).toHaveLength(0);

        await provider.holdRefreshResponses();
        const first = denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });
        await eventually(() => provider.pendingRefreshResponses(), { within: 8_000, intervalMs: 50, until: (responses) => responses.length === 1, label: "first refresh response held" });
        const second = denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });
        const pending = await eventually(() => provider.pendingRefreshResponses(), { within: 8_000, intervalMs: 50, until: (responses) => responses.length === 2, label: "two concurrent refresh responses held" });
        const success = pending.find((response) => response.status === 200);
        const failure = pending.find((response) => response.status === 400);
        expect(success).toBeDefined();
        expect(failure).toBeDefined();
        if (!success || !failure) throw new Error("Expected one successful rotation and one rejected refresh");
        expect(failure.tokenId).toBe(success.tokenId);
        await provider.releaseRefreshResponse(success.id);
        const refreshed = await first;
        expect(refreshed.response.status, refreshed.text).toBe(200);
        await provider.releaseRefreshResponse(failure.id);
        const recovered = await second;
        expect(recovered.response.status, recovered.text).toBe(200);
        const afterRace = await denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });
        expect(afterRace.response.status, afterRace.text).toBe(200);
        const raceLogs = await den.apiLog();
        expect(invalidations(raceLogs)).toHaveLength(0);
        const preserved = invalidations(raceLogs, "external_mcp_credential_invalidation_skipped");
        expect(preserved).toHaveLength(1);
        expect(preserved[0]).toMatchObject({ mode: credentialMode, reason: "provider-rejected", skip_reason: "revision-changed", revision_changed: true, had_access: true, had_refresh: true });
        expect(preserved[0].current_revision).not.toBe(preserved[0].loaded_revision);
        expect(preserved[0].diagnostic).toMatchObject({ httpStatus: 400, providerErrorMessage: expect.stringContaining("invalid_grant") });
        expect(JSON.stringify(preserved)).not.toMatch(/mock-access-|mock-refresh-|code_verifier|client_secret/);
        evidence.recordAssertionEvidence(`Den preserves renewed ${credentialMode} credentials after a late rejection`, "Two requests used the same refresh grant. The successful rotation completed before the held invalid_grant was released. A subsequent authenticated tools request succeeded, zero deletion events were logged, and one skipped invalidation named different loaded/current revisions.", true);

        await provider.resetOAuth();
        const tokenRequestsBefore = (await provider.requests()).filter((entry) => entry.path === "/token").length;
        const rejected = await denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });
        expect(rejected.response.ok).toBe(false);
        expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(tokenRequestsBefore + 1);
        const afterRejection = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
        if (!isRecord(afterRejection.body) || !Array.isArray(afterRejection.body.connections)) throw new Error("Connections missing after rejection");
        expect(afterRejection.body.connections.find((entry) => isRecord(entry) && entry.id === id)).toMatchObject({ connected: false });
        const logs = invalidations(await den.apiLog());
        expect(logs).toHaveLength(1);
        const [log] = logs;
        expect(log).toMatchObject({ reason: "provider-rejected", mode: credentialMode, had_access: true, had_refresh: true, revision_changed: false });
        expect(log.loaded_revision).toEqual(expect.any(String));
        expect(log.current_revision).toBe(log.loaded_revision);
        expect(log.org_membership_id).toEqual(credentialMode === "per_member" ? expect.any(String) : null);
        expect(log.organization_id).toEqual(expect.any(String));
        expect(log.diagnostic).toMatchObject({ httpStatus: 400, phase: "CONTINUITY_REFRESH", providerErrorMessage: expect.stringContaining("invalid_grant"), referenceId: expect.any(String) });
        expect(JSON.stringify(log)).not.toMatch(/mock-access-|mock-refresh-|code_verifier|client_secret/);
        evidence.recordAssertionEvidence(`Den logs committed ${credentialMode} SDK credential invalidation`, "One rejected refresh cleared the connection and produced exactly one structured log with provider error, member scope, and matching loaded/current revisions. Healthy reuse produced no invalidation log; token values and OAuth secrets were absent.", true);
      }
    }
  });
}

// Rows isolated in July kept their admin-registered client, so the provider
// still receives that client's shared redirect while Den signed a per-connection
// mode the shared callback route rejects. This journey seeds that stored state
// through the database (no supported surface produces it today) and signs in.
test("Den member sign-in recovers an isolated connection whose pre-registered client uses the shared callback", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: false }) },
    org: { name: `OAuth Callback Mode ${Date.now()}`, members: { teammate: {} } },
  });
  if (!den.database) throw new Error("Seeding the historical callback mode requires the isolated local testkit database");
  const provider = den.mocks.connector;
  const adminHeaders = { authorization: `Bearer ${den.admin.token}` };
  const memberHeaders = { authorization: `Bearer ${den.members.teammate.token}` };
  const tokenRequests = async () => (await provider.requests()).filter((entry) => entry.path === "/token").length;

  const created = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({
      name: "Registered shared callback", url: provider.mcpUrl, authType: "oauth", credentialMode: "per_member",
      oauthClient: { clientId: "mock-preregistered-client", clientSecret: "mock-preregistered-secret", tokenEndpointAuthMethod: "client_secret_post" },
      access: { orgWide: true },
    }),
  });
  expect(created.response.status, created.text).toBe(200);
  if (!isRecord(created.body) || typeof created.body.id !== "string" || typeof created.body.oauthCallbackUrl !== "string") throw new Error("Connection id or callback URL missing");
  const id = created.body.id;
  const sharedCallback = created.body.oauthCallbackUrl;
  expect(new URL(sharedCallback).pathname).toBe("/v1/mcp-connections/oauth/callback");
  expect(created.body).toMatchObject({ oauthCallbackMode: "shared-v1", oauthRegistrationSource: "pre-registered", oauthClientId: "mock-preregistered-client" });
  await queryDenDatabase(den.database.url, "UPDATE external_mcp_connection SET oauth_configuration = JSON_SET(oauth_configuration, '$.callbackMode', 'isolated-v1') WHERE id = ?", [id]);

  const detail = async () => {
    const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers: adminHeaders });
    expect(listed.response.status, listed.text).toBe(200);
    if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
    const connection = listed.body.connections.find((entry) => isRecord(entry) && entry.id === id);
    if (!isRecord(connection)) throw new Error("Seeded connection missing from the manageable list");
    return connection;
  };
  expect(await detail()).toMatchObject({ oauthCallbackMode: "isolated-v1", oauthCallbackUrl: sharedCallback, connected: false });
  evidence.recordAssertionEvidence("Stored callback mode disagrees with the registered redirect", "Admin detail reported an isolated-v1 callback mode while the effective callback URL was the shared route.", true);

  const started = await denFetch(den.members.teammate, `/v1/mcp-connections/${id}/connect/start`, { headers: memberHeaders });
  expect(started.response.status, started.text).toBe(200);
  if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
  const authorize = new URL(started.body.authorizeUrl);
  expect(authorize.searchParams.get("client_id")).toBe("mock-preregistered-client");
  expect(authorize.searchParams.get("redirect_uri")).toBe(sharedCallback);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await detail()).toMatchObject({ oauthCallbackMode: "shared-v1", oauthCallbackUrl: sharedCallback, oauthClientId: "mock-preregistered-client", oauthRegistrationSource: "pre-registered", connected: false });
  evidence.recordAssertionEvidence("Member sign-in records the shared callback mode without changing the registration", "connect/start sent the registered shared redirect with the same pre-registered client id; the stored mode now reads shared-v1 and nothing is connected yet.", true);

  const redirect = await fetch(authorize, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  const callback = new URL(redirect.headers.get("location")!);
  expect(`${callback.origin}${callback.pathname}`).toBe(sharedCallback);
  const before = await tokenRequests();
  const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const html = await completed.text();
  expect(completed.status, html).toBe(200);
  expect(html).toContain("connected");
  expect(await tokenRequests()).toBe(before + 1);
  expect(await detail()).toMatchObject({ connected: true, oauthCallbackMode: "shared-v1" });
  const tools = await denFetch(den.members.teammate, `/v1/mcp-connections/${id}/tools`, { headers: memberHeaders });
  expect(tools.response.status, tools.text).toBe(200);
  expect(tools.text).toContain("\"tools\"");
  const replay = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  expect(replay.status).toBe(400);
  expect(await tokenRequests()).toBe(before + 1);
  evidence.recordAssertionEvidence("Shared callback completes sign-in and authenticated discovery after recovery", "The provider redirected to the shared route; the callback returned HTTP 200 with exactly one token exchange, the member listed tools with the new credential, and replaying the callback was rejected without another exchange.", true);
});

// A provider that rejects the configured client's authentication used to make
// Den delete the administrator-supplied client and fall back to dynamic
// registration, losing the registered redirect. Only Den-created registrations
// may be discarded that way.
test("Den keeps an administrator-supplied OAuth client when the provider rejects its authentication", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    // The configured client is rejected only when its exact secret is presented:
    // a request that lost the secret would be issued tokens instead, so the
    // repeated rejection below observes the retained secret on the wire.
    mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: false, rejectTokenClientIds: ["admin-configured-client:admin-configured-secret", "@dynamic"] }) },
    org: { name: `OAuth Client Rejection ${Date.now()}`, members: {} },
  });
  const provider = den.mocks.connector;
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const providerCalls = async (path: string) => (await provider.requests()).filter((entry) => entry.path === path).length;
  const detail = async (id: string) => {
    const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
    expect(listed.response.status, listed.text).toBe(200);
    if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
    const connection = listed.body.connections.find((entry) => isRecord(entry) && entry.id === id);
    if (!isRecord(connection)) throw new Error("Connection missing from the manageable list");
    return connection;
  };
  const signIn = async (id: string) => {
    const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
    expect(started.response.status, started.text).toBe(200);
    if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
    const authorize = new URL(started.body.authorizeUrl);
    const redirect = await fetch(authorize, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const completed = await fetch(new URL(redirect.headers.get("location")!), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { clientId: authorize.searchParams.get("client_id"), status: completed.status, html: await completed.text() };
  };

  const created = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({
      name: "Administrator-configured client", url: provider.mcpUrl, authType: "oauth", credentialMode: "shared",
      oauthClient: { clientId: "admin-configured-client", clientSecret: "admin-configured-secret", tokenEndpointAuthMethod: "client_secret_post" },
      access: { orgWide: true },
    }),
  });
  expect(created.response.status, created.text).toBe(200);
  if (!isRecord(created.body) || typeof created.body.id !== "string" || typeof created.body.oauthCallbackUrl !== "string") throw new Error("Connection id or callback URL missing");
  const id = created.body.id;
  const callbackUrl = created.body.oauthCallbackUrl;
  expect(created.text).not.toContain("admin-configured-secret");

  const first = await signIn(id);
  expect(first.clientId).toBe("admin-configured-client");
  expect(first.status, first.html).toBe(400);
  expect(first.html).toContain("rejected the OAuth client configured for this connection");
  expect(first.html).toContain("Unsupported client authentication method");
  expect(first.html).not.toContain("admin-configured-secret");
  expect(await providerCalls("/token")).toBe(1);
  expect(await providerCalls("/register")).toBe(0);
  const afterRejection = await detail(id);
  expect(afterRejection).toMatchObject({
    connected: false, needsReconnect: true, credentialHealth: "reconnect_required", credentialHealthReason: "authorization_rejected",
    oauthClientConfigured: true, oauthClientId: "admin-configured-client", oauthRegistrationSource: "pre-registered", oauthCallbackUrl: callbackUrl,
  });
  expect(JSON.stringify(afterRejection)).not.toContain("admin-configured-secret");
  evidence.recordAssertionEvidence("Provider client rejection keeps the administrator-supplied client", "The callback page named the rejected configured client with the provider's own detail and no secret; the provider saw one token request and no registration; the connection reports reconnect_required with the same client id, source, and callback URL.", true);

  const second = await signIn(id);
  expect(second.clientId).toBe("admin-configured-client");
  expect(second.status, second.html).toBe(400);
  expect(second.html).toContain("Unsupported client authentication method");
  expect(await providerCalls("/token")).toBe(2);
  expect(await providerCalls("/register")).toBe(0);
  evidence.recordAssertionEvidence("Retrying presents the retained client id and secret without registering a replacement", "A second sign-in sent the same configured client id; the provider rejected it again with the secret-bound rule, which it only applies when the exact configured secret is presented, so a cleared secret would have been issued tokens instead. One more token request, still no dynamic registration.", true);

  const dynamic = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Dynamically registered client", url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
  });
  expect(dynamic.response.status, dynamic.text).toBe(200);
  if (!isRecord(dynamic.body) || typeof dynamic.body.id !== "string") throw new Error("Dynamic connection id missing");
  const dynamicFirst = await signIn(dynamic.body.id);
  expect(dynamicFirst.clientId).toMatch(/^mock-client-/);
  expect(dynamicFirst.status).toBe(400);
  expect(await providerCalls("/register")).toBe(1);
  expect(await detail(dynamic.body.id)).toMatchObject({ connected: false, oauthClientConfigured: false, oauthRegistrationSource: null });
  const dynamicSecond = await signIn(dynamic.body.id);
  expect(dynamicSecond.clientId).toMatch(/^mock-client-/);
  expect(dynamicSecond.clientId).not.toBe(dynamicFirst.clientId);
  expect(await providerCalls("/register")).toBe(2);
  expect(await detail(id)).toMatchObject({ oauthClientConfigured: true, oauthClientId: "admin-configured-client" });
  evidence.recordAssertionEvidence("Den-created registrations are still discarded and re-registered", "The dynamically registered connection lost its client after the same rejection and registered a fresh client on the next sign-in, while the administrator-configured connection kept its client.", true);
});
