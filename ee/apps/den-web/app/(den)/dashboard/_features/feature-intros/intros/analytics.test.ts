import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgAccessFlags } from "../../../../_lib/den-org";
import { analyticsHasActivity, analyticsUsageIntroFacts, libraryUsageIntroFacts, workflowRunsIntroFacts } from "../../../_components/analytics-intro-facts";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntroContext, FeatureIntroPermission } from "../types";
import { type AnalyticsFacts, analyticsIntros } from "./analytics";

const [section, library, runs] = analyticsIntros;

const orgContext = parseOrgContextPayload({
  organization: { id: "org_1", name: "Acme", slug: "acme" },
  currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
});
assert.ok(orgContext);
const ownerContext = orgContext;

function ctx(facts: AnalyticsFacts, permissions: readonly FeatureIntroPermission[] = ["canManageBilling", "canInviteMembers", "canManageConnections"]): FeatureIntroContext {
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

const quiet = {
  members: 1, pendingInvites: 0, activeMembers30d: 0, sessions30d: 0, tasksCompleted30d: 0, tasksFailed30d: 0,
  weekly: [{ weekStart: "2026-10-26", activeMembers: 0, sessions: 0, tasksCompleted: 0, tasksFailed: 0 }],
};

function sizeFor(intro: typeof library, facts: AnalyticsFacts) {
  return selectIntroSize({
    state: intro.setupState(ctx(facts)),
    parentState: intro.parent ? section.setupState(ctx(facts)) : null,
  })?.size ?? null;
}

test("analytics intros match each route tab", () => {
  assert.equal(matchFeatureIntro(analyticsIntros, "/dashboard/analytics", null)?.key, "analytics");
  assert.equal(matchFeatureIntro(analyticsIntros, "/dashboard/analytics/library", new URLSearchParams("view=skills"))?.key, "analytics.library");
  assert.equal(matchFeatureIntro(analyticsIntros, "/dashboard/analytics/workflow-runs", null)?.key, "analytics.workflow-runs");
});

test("facts come from the data each view already loads, null while loading", () => {
  assert.equal(analyticsUsageIntroFacts({ included: null, data: undefined, projectScoped: false }), null);
  assert.deepEqual(analyticsUsageIntroFacts({ included: false, data: undefined, projectScoped: false }), { page: "usage", included: false });
  assert.equal(analyticsUsageIntroFacts({ included: true, data: undefined, projectScoped: false }), null);
  assert.equal(analyticsUsageIntroFacts({ included: true, data: quiet, projectScoped: false })?.activity, false);
  assert.equal(analyticsUsageIntroFacts({ included: true, data: quiet, projectScoped: true })?.activity, true);
  assert.equal(analyticsHasActivity({ ...quiet, sessions30d: 1 }), true);
  assert.equal(analyticsHasActivity({ ...quiet, weekly: [{ ...quiet.weekly[0], activeMembers: 1 }] }), true);

  assert.equal(libraryUsageIntroFacts("skills", undefined), null);
  assert.equal(libraryUsageIntroFacts("skills", { kind: "plugins", trackingSince: null, items: [] }), null);
  assert.deepEqual(libraryUsageIntroFacts("skills", { kind: "skills", trackingSince: null, items: [] }), { page: "library", libraryView: "skills", libraryItems: 0, libraryUsageRecorded: false });
  const row = { id: "s", name: "Notes", detail: null, pluginId: null, uses: 0, people: 0, failures: null, lastUsedAt: null };
  assert.equal(libraryUsageIntroFacts("skills", { kind: "skills", trackingSince: "2026-10-01", items: [row] })?.libraryUsageRecorded, true);
  assert.equal(libraryUsageIntroFacts("skills", { kind: "skills", trackingSince: null, items: [{ ...row, uses: 3 }] })?.libraryUsageRecorded, true);

  assert.equal(workflowRunsIntroFacts(undefined), null);
  assert.deepEqual(workflowRunsIntroFacts([]), { page: "workflow-runs", workflowRuns: 0 });
});

test("Usage & adoption takes the page with no activity or no plan, never on a guess", () => {
  assert.equal(section.setupState(ctx({ page: "usage", included: true })), "done");
  assert.equal(section.setupState(ctx({ page: "usage", included: true, activity: false })), "none");
  assert.equal(section.setupState(ctx({ page: "usage", included: true, activity: true })), "done");
  assert.equal(section.setupState(ctx({ page: "usage", included: false })), "none");
  // Other views keep their own data, so the section never takes them over.
  assert.equal(section.setupState(ctx({ page: "library", included: false, activity: false })), "done");
});

test("tabs: box when empty, banner when nothing used yet, nothing once in use", () => {
  assert.equal(sizeFor(library, { page: "library", activity: false, libraryItems: 0, libraryUsageRecorded: false }), "box");
  assert.equal(sizeFor(library, { page: "library", libraryItems: 2, libraryUsageRecorded: false }), "banner");
  assert.equal(sizeFor(library, { page: "library", libraryItems: 2, libraryUsageRecorded: true }), null);
  assert.equal(sizeFor(library, { page: "library" }), null);
  assert.equal(sizeFor(runs, { page: "workflow-runs", workflowRuns: 0 }), "box");
  assert.equal(sizeFor(runs, { page: "workflow-runs", workflowRuns: 3 }), null);
  assert.equal(sizeFor(runs, { page: "workflow-runs" }), null);
});

test("actions follow the plan, the team and permissions", () => {
  assert.match(pickIntroCta(section, ctx({ page: "usage", included: false }))?.href ?? "", /^https:\/\//);
  assert.equal(pickIntroCta(section, ctx({ page: "usage", included: false }))?.locked, undefined);
  assert.match(pickIntroCta(section, ctx({ page: "usage", included: false }, []))?.locked?.reason ?? "", /Enterprise plan/);
  assert.equal(pickIntroCta(section, ctx({ page: "usage", included: true, activity: false, members: 1, pendingInvites: 0 }))?.label, "Invite your team");
  assert.equal(pickIntroCta(section, ctx({ page: "usage", included: true, activity: false, members: 1, pendingInvites: 0 }, []))?.label, "Download OpenWork");
  assert.equal(pickIntroCta(section, ctx({ page: "usage", included: true, activity: false, members: 4, pendingInvites: 0 }))?.href, "/install");

  assert.equal(pickIntroCta(library, ctx({ libraryView: "connectors", libraryItems: 0 }))?.href, "/dashboard/mcp-connections/new");
  assert.ok(pickIntroCta(library, ctx({ libraryView: "connectors", libraryItems: 0 }, []))?.locked);
  assert.equal(pickIntroCta(library, ctx({ libraryView: "skills", libraryItems: 0 }, []))?.href, "/dashboard/plugins/new");
  assert.equal(pickIntroCta(library, ctx({ libraryView: "skills", libraryItems: 3, libraryUsageRecorded: false }))?.label, "Download OpenWork");
  assert.equal(pickIntroCta(runs, ctx({ workflowRuns: 0 }, []))?.label, "Download OpenWork");
});
