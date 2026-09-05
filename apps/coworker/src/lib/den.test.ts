import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDenSignInUrl,
  buildDenAccountUrl,
  denApiBase,
  describeSkippedProvider,
  parsePastedGrant,
  providerSyncSession,
} from "./den.ts";

test("denApiBase follows the OpenWork desktop rule for hosted, explicit-api, and self-hosted Den", () => {
  assert.equal(denApiBase("https://app.openworklabs.com"), "https://api.app.openworklabs.com");
  assert.equal(denApiBase("https://api.openworklabs.com/"), "https://api.openworklabs.com");
  assert.equal(denApiBase("http://127.0.0.1:4100"), "http://127.0.0.1:4100/api/den");
});

test("account destinations preserve the Den origin and never carry credentials or a proposed offer", () => {
  const destinations: Array<["models" | "billing" | "connections", string]> = [["models", "/dashboard/inference"], ["billing", "/dashboard/billing"], ["connections", "/dashboard/your-connections"]];
  for (const [destination, path] of destinations) {
    const url = new URL(buildDenAccountUrl("https://user:secret@den.example/?grant=private#token", destination));
    assert.equal(url.origin, "https://den.example");
    assert.equal(url.pathname, path);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.hash, "");
    assert.equal(url.searchParams.get("grant"), null);
    assert.equal(url.searchParams.get("utm_source"), "opencoworker");
    assert.doesNotMatch(url.toString(), /private|secret|astra|offer/);
  }
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

test("describeSkippedProvider explains both skip reasons in plain language", () => {
  assert.match(describeSkippedProvider("needs_key"), /your own key/i);
  assert.match(describeSkippedProvider("missing_credentials"), /credential/i);
});
