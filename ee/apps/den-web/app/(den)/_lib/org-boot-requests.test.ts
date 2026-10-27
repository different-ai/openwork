import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOriginBrowserRequest } from "./den-api-origin";
import { bootOrgContextFor, shouldStartOrgBootRequests } from "./org-boot-requests";

function orgPayload(id: string) {
  return {
    organization: { id, name: "Workspace", slug: "workspace" },
    currentMember: { id: "member", userId: "user", role: "owner", isOwner: true, permissions: [] },
  };
}

test("a page load starts boot requests unless it is already pinned to a workspace", () => {
  assert.equal(shouldStartOrgBootRequests("https://den.example/dashboard/analytics", null), true);
  // An in-app load already scoped to a workspace asks for that workspace itself.
  assert.equal(shouldStartOrgBootRequests("https://den.example/dashboard/analytics", "org_a"), false);
  // A Workbot recovery link opens a specific team, so the session's active one is not useful.
  assert.equal(shouldStartOrgBootRequests("https://den.example/dashboard?workbotOrganizationId=org_b", null), false);
  assert.equal(shouldStartOrgBootRequests("not a url", null), false);
});

test("the unscoped boot workspace details are used only for the workspace being opened", () => {
  const ok = { response: { ok: true }, payload: orgPayload("org_a") };
  assert.equal(bootOrgContextFor(ok, "org_a")?.organization.id, "org_a");
  // Switched, remembered or setup workspaces load their own details.
  assert.equal(bootOrgContextFor(ok, "org_b"), null);
  // Failures fall back to the scoped request, which owns the not-found and error paths.
  assert.equal(bootOrgContextFor({ response: { ok: false }, payload: orgPayload("org_a") }, "org_a"), null);
  assert.equal(bootOrgContextFor({ response: { ok: true }, payload: { organization: null } }, "org_a"), null);
  assert.equal(bootOrgContextFor(null, "org_a"), null);
});

test("only same-origin browser requests skip waiting for the runtime API origin", () => {
  assert.equal(isSameOriginBrowserRequest("/v1/me"), true);
  assert.equal(isSameOriginBrowserRequest("/v1/me/orgs"), true);
  assert.equal(isSameOriginBrowserRequest("/v1/telemetry/analytics?x=1"), true);
  assert.equal(isSameOriginBrowserRequest("/api/auth/organization/set-active"), true);
  // Public Den API paths and absolute URLs go to the configured API origin.
  assert.equal(isSameOriginBrowserRequest("/v1/orgs/sso/resolve?email=a"), false);
  assert.equal(isSameOriginBrowserRequest("https://api.example/v1/me"), false);
  assert.equal(isSameOriginBrowserRequest("/health"), false);
});
