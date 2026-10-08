import { expect } from "vitest";
import { denFetch, eventually, mcpMock, needs, server, test } from "@openwork/testkit";

// Providers that rotate refresh tokens and keep only the newest one valid
// signed members out about an hour after connecting: when the access token
// expired, every in-flight request renewed it with the same refresh token,
// Den kept the first new token, and the provider had already replaced it.
for (const credentialMode of ["per_member", "shared"] as const) {
  test(`a ${credentialMode === "per_member" ? "member's" : "shared"} MCP connection stays signed in when several requests renew it at once`, { timeout: 300_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    await using den = await server({
      place, web: false,
      mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: false }) },
      org: { name: `Concurrent refresh ${Date.now()}`, members: {} },
    });
    const provider = den.mocks.connector;
    const headers = { authorization: `Bearer ${den.admin.token}` };
    const refreshGrants = async () => (await provider.requests())
      .filter((entry) => entry.path === "/token" && entry.grantType === "refresh_token").length;
    const rejectedMcpCalls = async () => (await provider.requests())
      .filter((entry) => entry.path === "/mcp" && entry.status === 401).length;
    const listTools = () => denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });

    const created = await denFetch(den.admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Rotating provider", url: provider.mcpUrl, authType: "oauth", credentialMode, access: { orgWide: true } }),
    });
    expect(created.response.status, created.text).toBe(200);
    if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
    const id = created.body.id;
    const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
    expect(started.response.status, started.text).toBe(200);
    if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
    const redirect = await fetch(started.body.authorizeUrl, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const completed = await fetch(new URL(redirect.headers.get("location")!), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(completed.status, await completed.text()).toBe(200);
    const signedIn = await listTools();
    expect(signedIn.response.status, signedIn.text).toBe(200);
    evidence.recordAssertionEvidence(
      "given a connected provider that keeps only its newest refresh token",
      `Sign-in completed and tools listed with HTTP ${signedIn.response.status}; the provider then expired every access token and made each refresh replace the previous refresh token.`,
      true,
    );

    await provider.holdRefreshResponses({ rotation: "keep-latest" });
    const refreshesBefore = await refreshGrants();
    const rejectionsBefore = await rejectedMcpCalls();
    const first = listTools();
    await eventually(() => provider.pendingRefreshResponses(), { within: 15_000, intervalMs: 50, until: (pending) => pending.length === 1, label: "first renewal held at the provider" });
    const others = [listTools(), listTools()];
    await eventually(rejectedMcpCalls, { within: 15_000, intervalMs: 50, until: (count) => count >= rejectionsBefore + 3, label: "all three requests saw the expired access token" });
    // Give requests that skip the wait time to reach the provider.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const pending = await provider.pendingRefreshResponses();
    evidence.recordAssertionEvidence(
      "when three requests find the access token expired at the same moment, only one renews it",
      `The provider rejected ${await rejectedMcpCalls() - rejectionsBefore} requests for the expired access token and received ${pending.length} refresh grant(s) while the first renewal was held.`,
      pending.length === 1,
    );
    if (pending.length !== 1) {
      for (const response of pending) await provider.releaseRefreshResponse(response.id);
      await Promise.allSettled([first, ...others]);
    }
    expect(pending).toHaveLength(1);

    for (const response of pending) await provider.releaseRefreshResponse(response.id);
    const results = await Promise.all([first, ...others]);
    const statuses = results.map((result) => result.response.status);
    const renewals = await refreshGrants() - refreshesBefore;
    evidence.recordAssertionEvidence(
      "then every waiting request uses the one renewed credential",
      `Tools requests returned ${statuses.join(" / ")}; the provider issued ${renewals} renewal.`,
      statuses.every((status) => status === 200) && renewals === 1,
    );
    expect(statuses).toEqual([200, 200, 200]);
    expect(renewals).toBe(1);

    await provider.holdRefreshResponses({ rotation: "keep-latest" });
    const next = listTools();
    const [renewal] = await eventually(() => provider.pendingRefreshResponses(), { within: 15_000, intervalMs: 50, until: (held) => held.length === 1, label: "next renewal held at the provider" });
    if (!renewal) throw new Error("Next renewal missing");
    await provider.releaseRefreshResponse(renewal.id);
    const renewed = await next;
    const invalidated = (await den.apiLog()).split(/\r?\n/).filter((line) =>
      line.includes("external_mcp_credential_invalidated") && line.includes(id));
    evidence.recordAssertionEvidence(
      "after: the saved refresh token still renews the connection an hour later",
      `The next renewal answered HTTP ${renewal.status} and tools listed with HTTP ${renewed.response.status}; Den logged ${invalidated.length} credential invalidations.`,
      renewal.status === 200 && renewed.response.status === 200 && invalidated.length === 0,
    );
    expect(renewal.status).toBe(200);
    expect(renewed.response.status, renewed.text).toBe(200);
    expect(invalidated).toHaveLength(0);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
