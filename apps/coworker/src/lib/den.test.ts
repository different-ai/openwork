import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDenSignInUrl,
  buildDenAccountUrl,
  parsePastedGrant,
  providerSyncSession,
  readCloudProviderSyncStatus,
  describeSkippedProvider,
} from "./den.ts";

test("account destinations preserve the Den origin and never carry credentials or a proposed offer", () => {
  const url = new URL(buildDenAccountUrl("https://user:secret@den.example/?grant=private#token", "models"));
  assert.equal(url.origin, "https://den.example");
  assert.equal(url.pathname, "/dashboard/inference");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.get("grant"), null);
  assert.doesNotMatch(url.toString(), /private|secret|astra|offer/);
  assert.throws(() => buildDenAccountUrl("javascript:alert(1)", "models"));
});

test("buildDenSignInUrl asks Den for this app's own handoff scheme", () => {
  const url = new URL(buildDenSignInUrl("https://app.openworklabs.com/", "opencoworker"));
  assert.equal(url.origin, "https://app.openworklabs.com");
  assert.equal(url.searchParams.get("mode"), "sign-in");
  assert.equal(url.searchParams.get("desktopAuth"), "1");
  assert.equal(url.searchParams.get("desktopScheme"), "opencoworker");
});

test("parsePastedGrant accepts this app's deep link, the OpenWork link, and a raw code — never a web page", () => {
  assert.deepEqual(
    parsePastedGrant("opencoworker://den-auth?grant=abc123def456&denBaseUrl=https%3A%2F%2Fapp.openworklabs.com"),
    { grant: "abc123def456", baseUrl: "https://app.openworklabs.com" },
  );
  assert.deepEqual(parsePastedGrant("openwork://den-auth?grant=abc123def456"), { grant: "abc123def456", baseUrl: undefined });
  assert.deepEqual(parsePastedGrant("  raw-grant-code-value  "), { grant: "raw-grant-code-value" });
  assert.equal(parsePastedGrant("https://app.openworklabs.com/?mode=sign-in"), null);
  assert.equal(parsePastedGrant("opencoworker://something-else?grant=abc123def456"), null);
  assert.equal(parsePastedGrant("short"), null);
  assert.equal(parsePastedGrant(""), null);
});

test("provider sync status retains ready providers alongside every Gateway setup reason", async (context) => {
  const reasons = ["missing_credentials", "needs_key", "member_auth_required", "org_credential_missing", "no_accessible_models"] as const;
  context.mock.method(globalThis, "fetch", async () => Response.json({
    hasSession: true, lastRun: { at: "2026-09-14T00:00:00Z", status: "applied" }, reloadPending: false,
    providers: [{ providerId: "ipr_ready", name: "OW OpenAI", source: "openwork_gateway", modelIds: ["gwm_ready"] }],
    skippedProviders: reasons.map((reason) => ({ providerId: "ipr_partial", name: "Pending set", credentialSetId: "set", reason })),
  }));
  const status = await readCloudProviderSyncStatus({ serverUrl: "https://fixture.test", token: "fixture" });
  assert.deepEqual(status.skippedProviders.map((provider) => provider.reason), reasons);
  assert.equal(status.providers[0]?.providerId, "ipr_ready");
  assert.equal(status.skippedProviders[2]?.credentialSetId, "set");
  for (const reason of reasons) assert.ok(describeSkippedProvider(reason));
});

test("providerSyncSession hands the embedded server the API origin, token, and organization", () => {
  assert.deepEqual(
    providerSyncSession({
      baseUrl: "https://app.openworklabs.com",
      token: "session-token",
      userName: "Jalil",
      userEmail: "jalil@example.com",
      orgId: "org_1",
      orgName: "Acme",
    }),
    { baseUrl: "https://api.app.openworklabs.com", token: "session-token", orgId: "org_1" },
  );
});
