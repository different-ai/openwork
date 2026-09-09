import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { mcpMock, needs, server, test } from "@openwork/testkit";
import { isRecord } from "../worlds/openwork-server-cli.ts";

// Journey: a member clicks Connect in the Den web dashboard. The browser sends
// a credentialed cross-origin GET to den-api's OAuth-start route. Every outcome
// of that request, including a downstream OAuth handshake failure, must reach
// the page as a readable response: exactly one Access-Control-Allow-Origin for
// the trusted web origin, credentials allowed, and nothing for other origins.
// A response the browser cannot read collapses to "Failed to fetch" in the UI.
test("Den OAuth-start answers browser preflights, successes and handshake failures with readable CORS headers", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    mocks: { connector: mcpMock() },
    org: { name: `OAuth Start CORS ${Date.now()}`, members: {} },
  });
  const webOrigin = new URL(den.ref.webUrl).origin;
  const untrustedOrigin = "https://untrusted.example.test";
  const headers = { authorization: `Bearer ${den.admin.token}` };
  // Headers.get() joins repeated headers with ", ", so a duplicate emitted by
  // two layers shows up as more than one value.
  const corsOf = (response: Response) => {
    const allowOrigin = response.headers.get("access-control-allow-origin");
    return {
      allowOrigin,
      allowCredentials: response.headers.get("access-control-allow-credentials"),
      allowOriginValues: (allowOrigin ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    };
  };
  const expectReadableFor = (response: Response, label: string) => {
    const cors = corsOf(response);
    expect(cors.allowOrigin, `${label}: allow-origin`).toBe(webOrigin);
    expect(cors.allowOriginValues, `${label}: exactly one allow-origin value`).toHaveLength(1);
    expect(cors.allowCredentials, `${label}: allow-credentials`).toBe("true");
  };

  const createConnection = async (name: string, mcpUrl: string) => {
    const created = await denFetch(den.admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name, url: mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }),
    });
    expect(created.response.status, created.text).toBe(200);
    if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
    return created.body.id;
  };

  const reachableId = await createConnection("Reachable provider", den.mocks.connector.mcpUrl);
  const startPath = (id: string) => `/v1/mcp-connections/${id}/connect/start`;

  // 1. Preflight: the browser asks before sending Authorization and the org header.
  const preflight = await denFetch(den.admin, startPath(reachableId), {
    method: "OPTIONS",
    headers: {
      origin: webOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,x-openwork-org-id,accept",
    },
  });
  expect(preflight.response.status, preflight.text).toBe(204);
  expectReadableFor(preflight.response, "preflight");
  const allowHeaders = (preflight.response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  expect(allowHeaders).toContain("authorization");
  expect(allowHeaders).toContain("x-openwork-org-id");
  expect((preflight.response.headers.get("access-control-allow-methods") ?? "").toUpperCase()).toContain("GET");
  evidence.recordAssertionEvidence("Preflight for OAuth start is answered for the trusted web origin", `OPTIONS returned HTTP 204 with allow-origin ${webOrigin}, credentials, Authorization and X-OpenWork-Org-Id allowed.`, true);

  // 2. Success: the authorize URL response is readable.
  const started = await denFetch(den.admin, startPath(reachableId), { headers: { ...headers, origin: webOrigin } });
  expect(started.response.status, started.text).toBe(200);
  expect(started.body).toMatchObject({ status: "needs_auth", authorizeUrl: expect.stringContaining(den.mocks.connector.url) });
  expectReadableFor(started.response, "success");
  evidence.recordAssertionEvidence("Successful OAuth start is readable from the browser", `HTTP 200 needs_auth carried one allow-origin ${webOrigin} and allow-credentials true.`, true);

  // 3. Downstream failure: the provider disappears after the connection was
  //    saved. Den must answer its structured 502 with the same CORS headers so
  //    the dashboard popup can show the diagnostic instead of "Failed to fetch".
  const { handle: vanishing } = await mcpMock().boot(place);
  let unreachableId: string;
  try {
    unreachableId = await createConnection("Vanishing provider", vanishing.mcpUrl);
  } finally {
    await vanishing.stop();
  }
  const failed = await denFetch(den.admin, startPath(unreachableId), { headers: { ...headers, origin: webOrigin } });
  expect(failed.response.status, failed.text).toBe(502);
  expect(failed.body).toMatchObject({ error: "oauth_handshake_failed", diagnostic: { referenceId: expect.any(String), phase: expect.any(String) } });
  expect(failed.text).not.toMatch(/code_verifier|client_secret|Bearer /);
  expectReadableFor(failed.response, "handshake failure");
  evidence.recordAssertionEvidence("OAuth handshake failure is readable from the browser", `HTTP 502 oauth_handshake_failed with a diagnostic reference carried one allow-origin ${webOrigin} and allow-credentials true; no secrets in the body.`, true);

  // 4. Authentication failure is readable too, so an expired session is not
  //    reported as a network failure.
  const unauthenticated = await denFetch(den.admin, startPath(reachableId), { headers: { origin: webOrigin } });
  expect(unauthenticated.response.status, unauthenticated.text).toBe(401);
  expectReadableFor(unauthenticated.response, "unauthenticated");
  evidence.recordAssertionEvidence("Unauthenticated OAuth start is readable from the browser", `HTTP 401 carried allow-origin ${webOrigin} and allow-credentials true.`, true);

  // 5. Negative half: an untrusted origin gets no allow-origin at all, on both
  //    the preflight and the failing request.
  const untrustedPreflight = await denFetch(den.admin, startPath(reachableId), {
    method: "OPTIONS",
    headers: { origin: untrustedOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  expect(untrustedPreflight.response.headers.get("access-control-allow-origin")).toBeNull();
  const untrustedFailure = await denFetch(den.admin, startPath(unreachableId), { headers: { ...headers, origin: untrustedOrigin } });
  expect(untrustedFailure.response.status, untrustedFailure.text).toBe(502);
  // Browsers gate on allow-origin; allow-credentials alone grants nothing.
  expect(untrustedFailure.response.headers.get("access-control-allow-origin")).toBeNull();
  evidence.recordAssertionEvidence("Untrusted origins never receive CORS allowance", `Preflight and HTTP 502 for ${untrustedOrigin} carried no allow-origin header.`, true);
});
