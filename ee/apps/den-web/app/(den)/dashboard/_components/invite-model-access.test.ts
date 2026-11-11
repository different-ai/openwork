import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayAccessProvider } from "./gateway-subject-access-data";
import { inviteModelAccess, inviteModelAccessStateLabel } from "./invite-model-access";

function provider(): GatewayAccessProvider {
  return {
    id: "provider", providerId: "openai", name: "OpenAI", status: "active", modelIds: [],
    credentialMode: "org", updatedAt: null, providerConfig: {}, catalogWarning: null,
    settings: {}, access: null, credentials: null, oauthClientId: null,
    hasOauthClientSecret: false, oauthCallbackUrl: null, authorizationRequests: [], litellm: null, custom: null,
    // Deliberately caller-specific: these must not influence the preview.
    models: [{ id: "caller-only", name: "Caller only", config: {} }], credentialStatus: "ready",
    modelGroups: [
      { id: "public", name: "Shared", description: null, status: "active", modelIds: ["shared-model"] },
      { id: "design", name: "Design", description: null, status: "active", modelIds: ["design-model"] },
      { id: "private", name: "Private", description: null, status: "active", modelIds: ["private-model"] },
    ],
    credentialSets: [{ id: "key", name: "Shared key", credentialMode: "org", configured: true, credentialStatus: "ready", status: "active" }],
    accessGrants: [
      { id: "a", modelGroupId: "public", credentialSetId: "key", audience: { type: "organization" } },
      { id: "b", modelGroupId: "design", credentialSetId: "key", audience: { type: "team", teamId: "design-team" } },
      { id: "c", modelGroupId: "private", credentialSetId: "key", audience: { type: "member", memberId: "inviter" } },
      { id: "d", modelGroupId: "private", credentialSetId: "key", audience: { type: "team", teamId: "other-team" } },
    ],
  };
}

test("No team includes only Everyone; selected team adds only its granted groups, never inviter or another team's models", () => {
  const p = provider();
  assert.deepEqual(inviteModelAccess([p], null).map((row) => row.modelIds), [["shared-model"]]);
  assert.deepEqual(inviteModelAccess([p], "design-team").map((row) => [row.modelIds, row.source]), [[["shared-model"], "everyone"], [["design-model"], "team"]]);
  assert.deepEqual(inviteModelAccess([p], "unrelated").map((row) => row.modelIds), [["shared-model"]]);
});

test("Provider presence, caller readiness, missing grants and dangling or disabled resources never imply access", () => {
  const p = provider();
  p.accessGrants = [];
  assert.deepEqual(inviteModelAccess([p], null), []);
  for (const change of [
    (p: GatewayAccessProvider) => { p.status = "disabled"; },
    (p: GatewayAccessProvider) => { p.modelGroups[0].status = "disabled"; },
    (p: GatewayAccessProvider) => { p.credentialSets[0].status = "disabled"; },
    (p: GatewayAccessProvider) => { p.modelGroups[0].modelIds = []; },
    (p: GatewayAccessProvider) => { p.credentialSets = []; },
    (p: GatewayAccessProvider) => { p.modelGroups = []; },
  ]) {
    const next = provider(); change(next);
    assert.deepEqual(inviteModelAccess([next], null), []);
  }
});

test("Shared credentials require both configuration and credential status, not aggregate provider status", () => {
  const p = provider();
  assert.equal(inviteModelAccess([p], null)[0].state, "shared_configured");
  p.credentialSets[0].credentialStatus = "org_credential_missing";
  assert.equal(inviteModelAccess([p], null)[0].state, "setup_required");
  p.credentialSets[0].credentialStatus = "ready";
  p.credentialSets[0].configured = false;
  assert.equal(inviteModelAccess([p], null)[0].state, "setup_required");
});

test("Member credentials never inherit inviter's ready token; sign-in remains pending", () => {
  const p = provider();
  p.credentialSets[0].credentialMode = "member";
  const row = inviteModelAccess([p], null)[0];
  assert.equal(row.state, "member_sign_in");
  assert.match(inviteModelAccessStateLabel(row.state), /pending/);
  p.credentialSets[0].configured = false;
  assert.equal(inviteModelAccess([p], null)[0].state, "member_setup");
});

test("Duplicate team/Everyone grants do not duplicate model groups or obscure Everyone's access", () => {
  const p = provider();
  p.accessGrants.unshift({ id: "duplicate", modelGroupId: "public", credentialSetId: "key", audience: { type: "team", teamId: "design-team" } });
  assert.equal(inviteModelAccess([p], "design-team").filter((row) => row.groupName === "Shared").length, 1);
  assert.equal(inviteModelAccess([p], "design-team")[0].source, "everyone");
});

test("Provider universe intersects group models; empty is unrestricted and unknown never implies readiness", () => {
  const p = provider();
  p.modelGroups[0].modelIds = ["shared-model", "excluded-model"];
  p.modelIds = ["shared-model"];
  assert.deepEqual(inviteModelAccess([p], null)[0].modelIds, ["shared-model"]);
  p.modelIds = ["different-model"];
  assert.deepEqual(inviteModelAccess([p], null), []);
  p.modelIds = [];
  assert.deepEqual(inviteModelAccess([p], null)[0].modelIds, ["shared-model", "excluded-model"]);
  p.modelIds = null;
  const unknown = inviteModelAccess([p], null)[0];
  assert.deepEqual(unknown.modelIds, []);
  assert.equal(unknown.state, "selection_unverified");
  assert.equal(inviteModelAccessStateLabel(unknown.state), "Model selection could not be verified");
});

test("Uses upstream model display names, but never borrows an unrelated caller model name or its access", () => {
  const p = provider();
  p.models = [
    { id: "gateway-alias", upstreamModelId: "shared-model", name: "Shared display name", config: {} },
    { id: "other-model", name: "Caller personal model", config: {} },
  ];
  const rows = inviteModelAccess([p], "design-team");
  assert.deepEqual(rows[0].modelNames, ["Shared display name"]);
  assert.deepEqual(rows[1].modelNames, [null]);
  assert.deepEqual(rows.flatMap((row) => row.modelIds), ["shared-model", "design-model"]);
});
