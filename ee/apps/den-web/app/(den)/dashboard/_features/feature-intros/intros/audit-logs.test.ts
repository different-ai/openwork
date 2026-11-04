import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgAccessFlags } from "../../../../_lib/den-org";
import { auditLogsIntroFacts } from "../../../_components/audit-logs-intro-facts";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntroContext, FeatureIntroPermission } from "../types";
import { type AuditLogsFacts, auditLogsIntros } from "./audit-logs";

const [intro] = auditLogsIntros;

const orgContext = parseOrgContextPayload({
  organization: { id: "org_1", name: "Acme", slug: "acme" },
  currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
});
assert.ok(orgContext);
const ownerContext = orgContext;

const admin: readonly FeatureIntroPermission[] = ["canViewAuditLogs", "canManageBilling", "canInviteMembers"];

function ctx(facts: AuditLogsFacts, permissions: readonly FeatureIntroPermission[] = admin): FeatureIntroContext {
  const access: DenOrgAccessFlags = getOrgAccessFlags("member", false);
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: ownerContext,
    access,
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

function sizeFor(facts: AuditLogsFacts) {
  return selectIntroSize({ state: intro.setupState(ctx(facts)), parentState: null })?.size ?? null;
}

test("audit logs intro matches its page", () => {
  assert.equal(matchFeatureIntro(auditLogsIntros, "/dashboard/audit-logs", null)?.key, "audit-logs");
});

test("facts: first unfiltered page only", () => {
  assert.equal(auditLogsIntroFacts({ included: true, filters: {}, operations: undefined }), null);
  assert.equal(auditLogsIntroFacts({ included: true, filters: { action: "team.create" }, operations: [] }), null);
  assert.deepEqual(auditLogsIntroFacts({ included: false, filters: {}, operations: [] }), { included: false, operations: 0 });
});

test("full screen with no history, banner when the plan stopped recording, nothing otherwise", () => {
  assert.equal(sizeFor({}), null);
  assert.equal(sizeFor({ included: false, operations: 0 }), "fullscreen");
  assert.equal(sizeFor({ included: true, operations: 0 }), "fullscreen");
  assert.equal(sizeFor({ included: false, operations: 12 }), "banner");
  assert.equal(sizeFor({ included: true, operations: 12 }), null);
});

test("actions: plan first, then the first recorded change, locked without permission", () => {
  assert.match(pickIntroCta(intro, ctx({ included: false, operations: 0 }))?.href ?? "", /^https:\/\//);
  assert.match(pickIntroCta(intro, ctx({ included: false, operations: 0 }, ["canViewAuditLogs"]))?.locked?.reason ?? "", /Enterprise plan/);
  assert.equal(pickIntroCta(intro, ctx({ included: true, operations: 0 }))?.href, "/dashboard/members?invite=1");
  assert.ok(pickIntroCta(intro, ctx({ included: true, operations: 0 }, ["canViewAuditLogs"]))?.locked);
  assert.match(pickIntroCta(intro, ctx({}, []))?.locked?.reason ?? "", /View audit history/);
});
