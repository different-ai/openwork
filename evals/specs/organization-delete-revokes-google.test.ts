import { createServer } from "node:http";
import { expect } from "vitest";
import { createNativeConnector, denFetch, freshSession } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";
import { googleWorkspaceRevocationTokens } from "../../ee/apps/den-api/src/organization-deletion-google-tokens";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

/** Records Google revoke calls; a preload in the Den child sends Google's revoke URL here. */
async function googleRevokeRecorder() {
  const tokens: string[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const token = new URLSearchParams(Buffer.concat(chunks).toString()).get("token");
    if (token) tokens.push(token);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("The revoke recorder did not bind");
  const preload = `
const originalFetch = globalThis.fetch;
const target = ${JSON.stringify(`http://127.0.0.1:${address.port}/revoke`)};
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://oauth2.googleapis.com/revoke") return originalFetch(input, init);
  return originalFetch(target, { method: init?.method ?? "POST", headers: init?.headers, body: init?.body, signal: init?.signal });
};`;
  return {
    nodeOptions: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    tokens: () => [...tokens],
    async [Symbol.asyncDispose]() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

test("only Google Workspace OAuth grants are picked for revocation", () => {
  const account = (providerId: string, refreshToken: string | null, accessToken: string | null, tokenType: string | null = "Bearer") =>
    ({ providerId, refreshToken, accessToken, tokenType });
  expect(googleWorkspaceRevocationTokens([
    account("google-workspace", "legacy-refresh", "legacy-access"),
    account("emc_google", null, "named-access"),
    account("emc_google", "duplicate", null),
    account("google-workspace", "duplicate", null),
    account("emc_other_mcp", "other-refresh", "other-access"),
    account("microsoft-365", "ms-refresh", "ms-access"),
    account("emc_google", null, "personal-api-key", "api_key"),
    account("google-workspace", null, null),
  ], ["emc_google"])).toEqual(["legacy-refresh", "named-access", "duplicate"]);
});

test("deleting an organization revokes members' Google Workspace grants at Google", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm"], placement: "local" });
  const email = "member@example.test";
  await using provider = await startMockGoogle({ accounts: [email], port: 0 });
  await using recorder = await googleRevokeRecorder();
  const organizationName = `Delete Revokes Google ${Date.now()}`;
  await using den = await server({
    place, web: false, org: { name: organizationName, members: { member: {} } },
    env: {
      DEN_GOOGLE_OAUTH_AUTHORIZE_URL: provider.authorizeUrl,
      DEN_GOOGLE_OAUTH_TOKEN_URL: provider.tokenUrl,
      DEN_GOOGLE_OAUTH_USERINFO_URL: provider.userinfoUrl,
      DEN_GOOGLE_API_BASE_URL: provider.apiUrl,
      NODE_OPTIONS: recorder.nodeOptions,
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("Missing test member");

  const connection = await createNativeConnector(den.admin, {
    providerKey: "google-workspace", name: "Workspace Google", features: ["driveFile"],
    clientId: "synthetic-delete-revoke", clientSecret: "synthetic-delete-revoke-secret",
  });
  const started = await denFetch(member, `/v1/mcp-connections/${connection.id}/connect/start`, { headers: { authorization: `Bearer ${member.token}` } });
  expect(started.response.status, started.text).toBe(200);
  const authorize = new URL(text(record(started.body).authorizeUrl));
  authorize.searchParams.set("prompt", "select_account");
  const page = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  expect(page.status).toBe(200);
  await provider.chooseAccount(email, { timeoutMs: 30_000 });
  const status = await denFetch(member, `/v1/oauth-providers/${connection.id}/status`, { headers: { authorization: `Bearer ${member.token}` } });
  expect(status.body).toMatchObject({ connected: true, externalAccountId: email });
  expect(recorder.tokens()).toEqual([]);

  const owner = await freshSession(den.admin);
  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === organizationName)).id);
  const deleted = await denFetch(owner, "/v1/org", { method: "DELETE", headers: { authorization: `Bearer ${owner.token}`, "x-openwork-org-id": orgId } });
  expect(deleted.response.status, deleted.text).toBe(200);
  expect(recorder.tokens()).toHaveLength(1);

  evidence.recordAssertionEvidence(
    "Organization deletion revokes connected Google grants",
    `A member connected Google Workspace through the OAuth flow; no revoke happened while connected. The owner's DELETE /v1/org returned 200 and Google's revoke endpoint received ${recorder.tokens().length} token.`,
    recorder.tokens().length === 1,
  );
});
