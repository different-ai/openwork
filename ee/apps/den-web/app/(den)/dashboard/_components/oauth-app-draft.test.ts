import assert from "node:assert/strict";
import { test } from "node:test";
import { createOAuthAppDraft, oauthAppTrustRequired, validateOAuthAppDraft, withOAuthAppManualDraft, type OAuthAppDraft } from "./oauth-app-draft";
import { manualOAuthDraft, reviewPublishedAddresses, undoPublishedAddresses } from "./manual-oauth-draft";

const url = "https://mcp.example.test/mcp";
const addresses = { authorizationEndpoint: "https://mcp.example.test/authorize", tokenEndpoint: "https://mcp.example.test/token" };
const options = { setupValidation: true, secretRequired: true, url };
function draft(input: Partial<OAuthAppDraft> = {}): OAuthAppDraft {
  return { ...createOAuthAppDraft(), clientId: "test-client", clientSecret: "test-only-secret", ...input };
}

test("new drafts are empty and independent", () => {
  const first = createOAuthAppDraft();
  assert.deepEqual(first, { clientId: "", clientSecret: "", manualDraft: manualOAuthDraft(), trustConfirmed: false });
  first.manualDraft.values.authorizationEndpoint = addresses.authorizationEndpoint;
  assert.equal(createOAuthAppDraft().manualDraft.values.authorizationEndpoint, "");
});

test("revised validation rejects blank credentials, including a required secret with manual endpoints", () => {
  assert.equal(validateOAuthAppDraft(draft({ clientId: "  " }), options).error?.field, "clientId");
  assert.equal(validateOAuthAppDraft(draft({ clientSecret: "  ", manualDraft: manualOAuthDraft(addresses) }), options).error?.field, "clientSecret");
  assert.equal(validateOAuthAppDraft(draft({ clientSecret: "" }), { ...options, secretRequired: false }).error, null);
});

test("revised validation permits automatic discovery only with both overrides blank", () => {
  assert.equal(validateOAuthAppDraft(draft(), options).error, null);
  for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof addresses)[]) {
    const result = validateOAuthAppDraft(draft({ manualDraft: manualOAuthDraft({ ...addresses, [field]: "  " }) }), options);
    assert.equal(result.error?.field, field);
    assert.equal(result.input, null, "partial overrides must not become automatic discovery");
  }
});

test("issuer mismatch needs a complete manually entered pair and explicit confirmation", () => {
  const mismatch = { ...options, issuerMismatch: true };
  assert.equal(validateOAuthAppDraft(draft({ trustConfirmed: true }), mismatch).error?.field, "authorizationEndpoint");
  const complete = draft({ manualDraft: manualOAuthDraft(addresses) });
  assert.equal(validateOAuthAppDraft(complete, mismatch).error?.field, "trustConfirmed");
  const confirmed = validateOAuthAppDraft({ ...complete, trustConfirmed: true }, mismatch);
  assert.deepEqual(confirmed.input, { clientId: "test-client", clientSecret: "test-only-secret", manualOAuthEndpoints: addresses });
  assert.equal(confirmed.error, null);
  assert.equal("trustConfirmed" in confirmed.input, false);
});

test("reviewing published addresses is not trust, even for same-host metadata", () => {
  for (const inconsistent of [false, true]) {
    const reviewed = draft({ manualDraft: reviewPublishedAddresses(manualOAuthDraft(), addresses, inconsistent) });
    assert.equal(oauthAppTrustRequired(reviewed, url), true);
    assert.equal(validateOAuthAppDraft(reviewed, options).error?.field, "trustConfirmed");
    assert.equal(validateOAuthAppDraft({ ...reviewed, trustConfirmed: true }, options).error, null);
  }
});

test("either different-host endpoint requires consent, while typed same-host endpoints do not", () => {
  assert.equal(validateOAuthAppDraft(draft({ manualDraft: manualOAuthDraft(addresses) }), options).error, null);
  for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof addresses)[]) {
    const manual = draft({ manualDraft: manualOAuthDraft({ ...addresses, [field]: "https://identity.example.test/oauth" }) });
    assert.equal(validateOAuthAppDraft(manual, options).error?.field, "trustConfirmed");
    assert.equal(validateOAuthAppDraft({ ...manual, trustConfirmed: true }, options).error, null);
  }
});

test("revised validation rejects malformed and unsafe endpoint URLs on either field despite confirmation", () => {
  for (const value of ["not a URL", "/authorize", "javascript:alert(1)", "ftp://mcp.example.test/oauth", "http://mcp.example.test/oauth", "https://user:password@mcp.example.test/oauth", "https://mcp.example.test/oauth#fragment", "https://mcp.example.test/oauth?access_token=test-only-value", "https://mcp.example.test/oauth?%2563ode=test-only-value"]) {
    for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof addresses)[]) {
      const result = validateOAuthAppDraft(draft({ trustConfirmed: true, manualDraft: manualOAuthDraft({ ...addresses, [field]: value }) }), options);
      assert.equal(result.error?.field, field, `${field}: ${value}`);
      assert.equal(result.input, null);
    }
  }
});

test("the existing exact localhost HTTP policy is preserved", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    const manual = manualOAuthDraft({ authorizationEndpoint: `http://${hostname}:1234/authorize`, tokenEndpoint: `http://${hostname}:1234/token` });
    assert.equal(validateOAuthAppDraft(draft({ manualDraft: manual, trustConfirmed: true }), options).error, null);
  }
  for (const hostname of ["127.0.0.2", "sub.localhost"]) {
    assert.equal(validateOAuthAppDraft(draft({ manualDraft: manualOAuthDraft({ ...addresses, tokenEndpoint: `http://${hostname}/token` }), trustConfirmed: true }), options).error?.field, "tokenEndpoint");
  }
});

test("endpoint edits, changed reviews and Undo reset consent; credential-only edits preserve it", () => {
  const confirmed = draft({ manualDraft: manualOAuthDraft(addresses), trustConfirmed: true });
  assert.equal(withOAuthAppManualDraft(confirmed, manualOAuthDraft(addresses)).trustConfirmed, true);
  assert.equal(withOAuthAppManualDraft({ ...confirmed, clientId: "changed", clientSecret: "" }, manualOAuthDraft(addresses)).trustConfirmed, true);
  for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof addresses)[]) {
    assert.equal(withOAuthAppManualDraft(confirmed, manualOAuthDraft({ ...addresses, [field]: `${addresses[field]}/changed` })).trustConfirmed, false);
  }
  const reviewed = reviewPublishedAddresses(confirmed.manualDraft, addresses, true);
  assert.equal(withOAuthAppManualDraft(confirmed, reviewed).trustConfirmed, false, "reviewing does not grant consent");
  const confirmedReview = { ...confirmed, manualDraft: reviewed };
  assert.equal(withOAuthAppManualDraft(confirmedReview, reviewPublishedAddresses(reviewed, { ...addresses, tokenEndpoint: `${addresses.tokenEndpoint}/new` }, true)).trustConfirmed, false);
  assert.equal(withOAuthAppManualDraft(confirmedReview, undoPublishedAddresses(reviewed)).trustConfirmed, false);
});

test("preset setup preserves its submission without introducing custom-setup validation", () => {
  const empty = validateOAuthAppDraft(createOAuthAppDraft(), { secretRequired: true });
  assert.deepEqual(empty.input, { clientId: "", clientSecret: "" });
  const partial = draft({ manualDraft: manualOAuthDraft({ authorizationEndpoint: addresses.authorizationEndpoint, tokenEndpoint: "" }) });
  assert.deepEqual(validateOAuthAppDraft(partial, { ...options, setupValidation: false, issuerMismatch: true }).input, { clientId: "test-client", clientSecret: "test-only-secret" });
});
