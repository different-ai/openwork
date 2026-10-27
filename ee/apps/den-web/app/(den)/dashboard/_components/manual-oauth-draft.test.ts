import assert from "node:assert/strict";
import { test } from "node:test";
import { manualOAuthDestination, manualOAuthDraft, publishedAddressesUnsaved, publishedFieldUnsaved, reviewPublishedAddresses, undoPublishedAddresses } from "./manual-oauth-draft";

const saved = { authorizationEndpoint: "https://mcp.example.test/old-authorize", tokenEndpoint: "https://mcp.example.test/old-token" };
const published = { authorizationEndpoint: "https://mcp.example.test/authorize", tokenEndpoint: "https://mcp.example.test/token" };

test("review fills both fields without mutating saved values, and Undo restores the previous draft", () => {
  const previous = manualOAuthDraft({ ...saved, authorizationEndpoint: "https://mcp.example.test/unsaved-edit" });
  const reviewed = reviewPublishedAddresses(previous, published, true);
  assert.deepEqual(reviewed.values, published);
  assert.deepEqual(previous.values, { ...saved, authorizationEndpoint: "https://mcp.example.test/unsaved-edit" });
  assert.equal(publishedAddressesUnsaved(reviewed, saved), true);
  assert.equal(publishedFieldUnsaved(reviewed, "authorizationEndpoint", saved), true);
  assert.equal(publishedFieldUnsaved(reviewed, "tokenEndpoint", saved), true);
  assert.deepEqual(undoPublishedAddresses(reviewed), previous);
  assert.equal(publishedAddressesUnsaved(undoPublishedAddresses(reviewed), saved), false);
});

test("editing a published field removes only that field's provenance; save removes all unsaved provenance", () => {
  const reviewed = reviewPublishedAddresses(manualOAuthDraft(saved), published, true);
  const edited = { ...reviewed, values: { ...reviewed.values, authorizationEndpoint: "https://mcp.example.test/typed" } };
  assert.equal(publishedFieldUnsaved(edited, "authorizationEndpoint", saved), false);
  assert.equal(publishedFieldUnsaved(edited, "tokenEndpoint", saved), true);
  assert.equal(publishedAddressesUnsaved(edited, saved), true);
  assert.equal(publishedAddressesUnsaved(manualOAuthDraft(edited.values), edited.values), false);
  assert.equal(publishedAddressesUnsaved(reviewed, published), false);
});

test("public-client trust copy omits a secret and names the same token host", () => {
  const result = manualOAuthDestination("https://mcp.example.test/mcp", published, false);
  assert.equal(result.differentHost, false);
  assert.equal(result.message, "Your users' sign-in codes will go to mcp.example.test (same host as the MCP server).");
  assert.doesNotMatch(result.message, /client secret/);
});

test("a configured secret is named, and either differing endpoint host leads with the cross-host warning", () => {
  const confidential = manualOAuthDestination("https://mcp.example.test/mcp", published, true);
  assert.match(confidential.message, /sign-in codes and the client secret will go to mcp.example.test/);
  for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof published)[]) {
    for (const hasSecret of [false, true]) {
      const crossHost = manualOAuthDestination("https://mcp.example.test/mcp", { ...published, [field]: "https://identity.example.test/oauth" }, hasSecret);
      assert.equal(crossHost.differentHost, true);
      assert.equal(crossHost.message, `Different host: your users' sign-in codes${hasSecret ? " and the client secret" : ""} will go to identity.example.test, not the MCP server's host (mcp.example.test).`);
      assert.equal(crossHost.beforeHost + crossHost.host + crossHost.afterHost, crossHost.message);
    }
  }
});
