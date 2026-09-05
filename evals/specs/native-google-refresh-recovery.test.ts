import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value;
}

// The control executes only unchanged behavior against clean dev product code.
// Google and Microsoft both use the real default resolver, never an injected token.
test("native Google refresh and Microsoft compatibility preserve reconnect and disconnect boundaries", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", optIn: ["OPENWORK_EVAL_NATIVE_GOOGLE_REFRESH"] });
  const compatibilityOnly = process.env.OPENWORK_EVAL_NATIVE_REFRESH_COMPATIBILITY_ONLY === "1";
  await using google = await startMockGoogle({ accounts: ["mailbox@example.test"], port: 0 });
  await using den = await server({ place, web: false, org: { members: {} }, env: {
    DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
    DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl,
    DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
    DEN_GOOGLE_API_BASE_URL: google.apiUrl,
    DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: `${google.authorizeUrl}?tenant={tenantId}`,
    DEN_MICROSOFT_OAUTH_TOKEN_URL: `${google.tokenUrl}?tenant={tenantId}`,
    DEN_MICROSOFT_GRAPH_BASE_URL: `${google.apiUrl}/v1.0`,
    SENTRY_DSN: "",
  } });
  const headers = { authorization: `Bearer ${den.admin.token}` };
  async function control(body?: Record<string, unknown>) {
    const response = await fetch(`${google.apiUrl}/__mock-google/refresh-control`, body ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {});
    expect(response.status).toBe(200);
    return record(await response.json());
  }
  async function waitForRefreshes(count: number) {
    const deadline = Date.now() + 8_000;
    while ((await control()).pending !== count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect((await control()).pending).toBe(count);
  }
  async function requests(path: string) {
    const body = record(await (await fetch(`${google.apiUrl}/requests`)).json());
    if (!Array.isArray(body.requests)) throw new Error("Missing provider request witness");
    return body.requests.map(record).filter(request => request.path === path);
  }

  for (const providerId of ["google-workspace", "microsoft-365"]) {
    const microsoft = providerId === "microsoft-365";
    const apiPath = microsoft ? "mail-messages" : "gmail-messages";
    const providerPath = microsoft ? "/v1.0/me/messages" : "/gmail/v1/users/me/messages";
    const configuration = await denFetch(den.admin, `/v1/oauth-providers/${providerId}/client`, {
      method: "POST", headers, body: JSON.stringify({
        clientId: `refresh-fixture-${providerId}`, clientSecret: "synthetic-secret",
        features: [microsoft ? "mailRead" : "gmailRead"],
        ...(microsoft ? { tenantId: "example.onmicrosoft.com" } : {}),
      }),
    });
    expect(configuration.response.status, configuration.text).toBe(200);
    const read = () => denFetch(den.admin, `/v1/capabilities/${providerId}/${apiPath}`, { headers });
    const status = () => denFetch(den.admin, `/v1/oauth-providers/${providerId}/status`, { headers });
    async function disconnect() {
      const result = await denFetch(den.admin, `/v1/oauth-providers/${providerId}/disconnect`, { method: "POST", headers });
      expect(result.response.status, result.text).toBe(200);
    }
    async function connect(expiresIn = 1) {
      await control({ authorizationExpiresIn: expiresIn });
      const started = await denFetch(den.admin, `/v1/oauth-providers/${providerId}/connect/start`, { headers });
      expect(started.response.status, started.text).toBe(200);
      const url = record(started.body).authorizeUrl;
      if (typeof url !== "string") throw new Error("Missing authorize URL");
      expect(new URL(url).origin).toBe(new URL(google.apiUrl).origin);
      if (microsoft) expect(new URL(url).searchParams.get("tenant")).toBe("example.onmicrosoft.com");
      const result = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      expect(result.status).toBe(200);
      if (microsoft) {
        expect(await result.text()).toContain("Connection complete");
      } else {
        expect(await result.text()).toContain("Choose an account");
        await google.chooseAccount("mailbox@example.test", { timeoutMs: 15_000 });
      }
      const connected = await status();
      expect(connected.response.status, connected.text).toBe(200);
      expect(connected.body).toMatchObject({ connected: true });
    }
    function proved(claim: string, detail: string) {
      evidence.recordAssertionEvidence(`${providerId}: ${claim}`, detail, true);
    }
    await control({ refreshError: null, holdRefresh: false });

    if (!compatibilityOnly) {
      await control({ refreshError: "invalid_grant" });
      await connect();
      const before = Number((await control()).attempts);
      const mailBefore = (await requests(providerPath)).length;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const rejected = await read();
        expect(rejected.response.status, rejected.text).toBe(409);
        expect(rejected.body).toMatchObject({ error: "needs_connection" });
        expect(record(rejected.body).message).toContain(microsoft ? "Microsoft" : "Google");
        expect((await control()).attempts).toBe(before + attempt);
        expect((await status()).body).toMatchObject({ connected: true });
      }
      expect((await requests(providerPath)).length).toBe(mailBefore);
      proved("Repeated revoked grants return 409 without mailbox access", "Three explicit reads made exactly three refresh attempts and no mailbox requests. Status continued to report connected: true: retained credentials are an existing UI-status limitation, not a claim of durable invalidation.");
    }

    await connect();
    await control({ refreshError: "temporarily_unavailable" });
    const unavailable = await read();
    expect(unavailable.response.status, unavailable.text).toBe(microsoft ? 502 : 500);
    expect(unavailable.body).not.toMatchObject({ error: "needs_connection" });
    await control({ refreshError: null });
    expect((await read()).response.status).toBe(200);
    proved("Temporary failures preserve recovery", "Provider unavailability retained the existing error classification (Google 500; Microsoft 502). The next read refreshed successfully without another authorization.");

    await connect(3600);
    const freshAttempts = (await control()).attempts;
    expect((await read()).response.status).toBe(200);
    expect((await read()).response.status).toBe(200);
    expect((await control()).attempts).toBe(freshAttempts);
    proved("Fresh credentials avoid token-endpoint work", "Two valid-token mail reads succeeded without any refresh attempt.");

    await connect();
    await control({ holdRefresh: true });
    const concurrent = Promise.all([read(), read()]);
    try { await waitForRefreshes(2); }
    finally { await control({ holdRefresh: false, release: true }); }
    expect((await concurrent).map(result => result.response.status)).toEqual([200, 200]);
    expect((await read()).response.status).toBe(200);
    proved("Concurrent successful refreshes retain a usable successor", "Two held successful refresh responses completed concurrently; both waiting reads and a later read succeeded.");

    // Run the success path on both clean dev and the PR. The rejection variant
    // checks the new handler only; clean dev is known to throw on invalid_grant.
    for (const refreshError of compatibilityOnly ? [null] : [null, "invalid_grant"]) {
      await connect();
      await control({ refreshError, holdRefresh: true });
      const lateRead = read();
      let replacementToken: unknown;
      try {
        await waitForRefreshes(1);
        await connect(3600);
        expect((await read()).response.status).toBe(200);
        replacementToken = (await requests(providerPath)).at(-1)?.tokenId;
        expect(typeof replacementToken).toBe("string");
      } finally { await control({ holdRefresh: false, release: true }); }
      expect((await lateRead).response.status).toBe(200);
      expect((await requests(providerPath)).at(-1)?.tokenId).toBe(replacementToken);
      const attemptsAfter = (await control()).attempts;
      expect((await read()).response.status).toBe(200);
      expect((await requests(providerPath)).at(-1)?.tokenId).toBe(replacementToken);
      expect((await control()).attempts).toBe(attemptsAfter);
      proved(`${refreshError ?? "successful refresh"} cannot overwrite reconnect`, "A new authorization completed while the old refresh was held. The waiting read and a subsequent read used the exact replacement credential fingerprint, without another refresh.");

      await connect();
      await control({ holdRefresh: true });
      const disconnectedRead = read();
      const mailBefore = (await requests(providerPath)).length;
      try { await waitForRefreshes(1); await disconnect(); }
      finally { await control({ holdRefresh: false, release: true }); }
      expect((await disconnectedRead).response.status).toBe(409);
      expect((await status()).body).toMatchObject({ connected: false });
      const attemptsAfterDisconnect = (await control()).attempts;
      expect((await read()).response.status).toBe(409);
      expect((await control()).attempts).toBe(attemptsAfterDisconnect);
      expect((await requests(providerPath)).length).toBe(mailBefore);
      proved(`Disconnect wins over ${refreshError ?? "successful refresh"}`, "Disconnect completed before the held token response. Both waiting and later reads required connection, status remained disconnected, and no mail call or additional refresh occurred.");
    }
  }
});
