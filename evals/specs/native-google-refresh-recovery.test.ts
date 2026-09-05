import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value;
}

// Native-provider refresh and reconnect is separate from OpenWork's MCP OAuth grants.
test("native Google refresh rejects revoked grants safely and preserves a concurrent reconnect", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", optIn: ["OPENWORK_EVAL_NATIVE_GOOGLE_REFRESH"] });
  await using google = await startMockGoogle({ accounts: ["mailbox@example.test"], port: 0 });
  await using den = await server({ place, web: false, org: { members: {} }, env: {
    DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
    DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl,
    DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
    DEN_GOOGLE_API_BASE_URL: google.apiUrl,
    SENTRY_DSN: "",
  } });
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const configured = await denFetch(den.admin, "/v1/oauth-providers/google-workspace/client", {
    method: "POST", headers, body: JSON.stringify({ clientId: "refresh-fixture", clientSecret: "synthetic-secret", features: ["gmailRead"] }),
  });
  expect(configured.response.status, configured.text).toBe(200);
  async function control(body?: Record<string, unknown>) {
    const response = await fetch(`${google.apiUrl}/__mock-google/refresh-control`, body ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {});
    expect(response.status).toBe(200);
    return record(await response.json());
  }
  async function connect() {
    const started = await denFetch(den.admin, "/v1/oauth-providers/google-workspace/connect/start", { headers });
    expect(started.response.status, started.text).toBe(200);
    const url = record(started.body).authorizeUrl;
    if (typeof url !== "string") throw new Error("Missing authorize URL");
    expect(new URL(url).origin).toBe(new URL(google.apiUrl).origin);
    const result = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("Choose an account");
    await google.chooseAccount("mailbox@example.test", { timeoutMs: 15_000 });
    const status = await denFetch(den.admin, "/v1/oauth-providers/google-workspace/status", { headers });
    expect(status.response.status, status.text).toBe(200);
    expect(status.body).toMatchObject({ connected: true });
  }
  async function waitForRefreshes(count: number) {
    const deadline = Date.now() + 8_000;
    while ((await control()).pending !== count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect((await control()).pending).toBe(count);
  }
  const read = () => denFetch(den.admin, "/v1/capabilities/google-workspace/gmail-messages", { headers });
  await control({ authorizationExpiresIn: 1, refreshError: "invalid_grant" });
  await connect();
  const revoked = await read();
  expect(revoked.response.status, revoked.text).toBe(409);
  expect(revoked.body).toMatchObject({ error: "needs_connection" });
  expect(record(revoked.body).message).toContain("Connect your Google account");
  expect((await control()).attempts).toBe(1);
  const requests = record(await (await fetch(`${google.apiUrl}/requests`)).json()).requests;
  expect(Array.isArray(requests)).toBe(true);
  expect(JSON.stringify(requests)).not.toContain("/gmail/v1/");
  evidence.recordAssertionEvidence("Revoked native credentials return actionable reconnect without automatic retries or mailbox access", "A real Den Gmail request received 409 needs_connection and Connect guidance after one rejected provider refresh; no Gmail endpoint was called.", true);

  await control({ refreshError: "temporarily_unavailable" });
  const unavailable = await read();
  expect(unavailable.response.status).toBe(500);
  expect(unavailable.body).not.toMatchObject({ error: "needs_connection" });
  await control({ refreshError: null });
  const recovered = await read();
  expect(recovered.response.status, recovered.text).toBe(200);
  expect((await control()).attempts).toBe(3);
  evidence.recordAssertionEvidence("Temporary provider failures preserve the grant for retry", "A provider outage remained a server failure, not a false reconnect response; the next request refreshed the same grant successfully without new authorization.", true);

  await connect();
  await control({ holdRefresh: true });
  const concurrent = Promise.all([read(), read()]);
  try {
    await waitForRefreshes(2);
  } finally {
    await control({ holdRefresh: false, release: true });
  }
  expect((await concurrent).map(result => result.response.status)).toEqual([200, 200]);
  expect((await read()).response.status).toBe(200);
  expect((await control()).attempts).toBe(5);
  evidence.recordAssertionEvidence("Concurrent successful refreshes preserve a usable successor", "Two held refreshes completed concurrently; both Gmail requests and a later read succeeded with no additional refresh.", true);

  await connect(); // Issue another short-lived access token.
  await control({ refreshError: "invalid_grant", holdRefresh: true });
  const lateRead = read();
  try {
    await waitForRefreshes(1);
    await control({ authorizationExpiresIn: 3600 });
    await connect();
  } finally {
    await control({ holdRefresh: false, release: true });
  }
  const late = await lateRead;
  expect(late.response.status, late.text).toBe(200);
  expect((await read()).response.status).toBe(200);
  expect((await control()).attempts).toBe(6);
  evidence.recordAssertionEvidence("A stale refresh rejection cannot erase a newer reconnect", "Held an old grant's refresh at the provider, completed a new PKCE connection, then released invalid_grant. Both the waiting Gmail read and a later read succeeded without another refresh.", true);

  await control({ authorizationExpiresIn: 1, holdRefresh: true });
  await connect();
  const disconnectedRead = read();
  try {
    await waitForRefreshes(1);
    const disconnected = await denFetch(den.admin, "/v1/oauth-providers/google-workspace/disconnect", { method: "POST", headers });
    expect(disconnected.response.status, disconnected.text).toBe(200);
  } finally {
    await control({ holdRefresh: false, release: true });
  }
  expect((await disconnectedRead).response.status).toBe(409);
  expect((await read()).response.status).toBe(409);
  expect((await control()).attempts).toBe(7);
  evidence.recordAssertionEvidence("Explicit disconnect wins over a stale refresh failure", "Disconnected while a rejected refresh was held. Both the held and subsequent Gmail reads returned needs_connection with no new refresh or recreated credentials.", true);
});
