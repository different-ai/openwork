import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgAccessFlags } from "../../../../_lib/den-org";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroFacts, FeatureIntroPermission } from "../types";
import { membersIntros } from "./members";
import { teamDetailIntros } from "./team-detail";

const all = [...membersIntros, ...teamDetailIntros];
const byKey = (key: string): FeatureIntro => {
  const intro = all.find((entry) => entry.key === key);
  assert.ok(intro, key);
  return intro;
};
const members = byKey("members");
const teams = byKey("members.teams");
const roles = byKey("members.roles");

const orgContext = parseOrgContextPayload({
  organization: { id: "org_1", name: "Acme", slug: "acme" },
  currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
});
assert.ok(orgContext);
const ownerContext = orgContext;

const ADMIN: readonly FeatureIntroPermission[] = ["canInviteMembers", "canManageTeams", "canManagePermissions", "canManageAdminTeams", "canManageGatewayProviders"];

function ctx(facts: FeatureIntroFacts, permissions: readonly FeatureIntroPermission[] = ADMIN): FeatureIntroContext {
  const access: DenOrgAccessFlags = getOrgAccessFlags("member", false);
  return { orgId: "org_1", orgSlug: "acme", orgContext: ownerContext, access, isAdmin: false, can: (permission) => permissions.includes(permission), memberName: () => null, facts };
}

function sizeFor(intro: FeatureIntro, facts: FeatureIntroFacts): string | null {
  const parent = intro.parent ? byKey(intro.parent) : null;
  return selectIntroSize({ state: intro.setupState(ctx(facts)), parentState: parent ? parent.setupState(ctx(facts)) : null })?.size ?? null;
}

test("members intros match the page, its tabs, Create role and team tabs (Everyone included)", () => {
  assert.equal(matchFeatureIntro(all, "/dashboard/members", null)?.key, "members");
  assert.equal(matchFeatureIntro(all, "/dashboard/members", new URLSearchParams("tab=teams"))?.key, "members.teams");
  assert.equal(matchFeatureIntro(all, "/dashboard/members", new URLSearchParams("tab=roles"))?.key, "members.roles");
  assert.equal(matchFeatureIntro(all, "/dashboard/members/roles/new", null)?.key, "members.roles.new");
  assert.equal(matchFeatureIntro(all, "/dashboard/members/teams/tem_1", new URLSearchParams("tab=overview"))?.key, "team-detail.members");
  assert.equal(matchFeatureIntro(all, "/dashboard/members/teams/everyone", new URLSearchParams("tab=prompts"))?.key, "team-detail.prompts");
  assert.equal(matchFeatureIntro(all, "/dashboard/members/teams/tem_1", new URLSearchParams("tab=workbot"))?.key, "team-detail.workbot");
});

test("the Members section takes the page only when the viewer is alone, and never on a guess", () => {
  assert.equal(members.setupState(ctx({})), "done");
  assert.equal(members.setupState(ctx({ people: 1, pendingInvites: 0, teams: 0 })), "none");
  assert.equal(members.setupState(ctx({ people: 2, pendingInvites: 0, teams: 0 })), "done");
  assert.equal(members.setupState(ctx({ people: 1, pendingInvites: 1, teams: 0 })), "done");
  assert.equal(members.setupState(ctx({ people: 1, pendingInvites: 0, teams: 1 })), "done");
});

test("Teams and Roles show a box in place of their empty list", () => {
  const people = { people: 3, pendingInvites: 0 };
  assert.equal(sizeFor(teams, { ...people, teams: 0 }), "box");
  assert.equal(sizeFor(teams, { ...people, teams: 2 }), null);
  assert.equal(sizeFor(roles, { ...people, teams: 1, customRoles: 0 }), "box");
  assert.equal(sizeFor(roles, { ...people, teams: 1 }), null);
  assert.equal(sizeFor(roles, { ...people, teams: 1, customRoles: 1 }), null);
});

test("Members actions go straight to the form, or lock with the missing permission", () => {
  assert.equal(pickIntroCta(members, ctx({ people: 1 }))?.href, "/dashboard/members?invite=1");
  assert.match(pickIntroCta(members, ctx({ people: 1 }, []))?.locked?.reason ?? "", /Invite people/);
  assert.equal(pickIntroCta(teams, ctx({ teams: 0 }))?.href, "/dashboard/members?tab=teams&newTeam=1");
  assert.match(pickIntroCta(teams, ctx({ teams: 0 }, []))?.locked?.reason ?? "", /Manage teams/);
  assert.equal(pickIntroCta(roles, ctx({ customRoles: 0 }))?.href, "/dashboard/members/roles/new");
  assert.match(pickIntroCta(roles, ctx({ customRoles: 0 }, ["canManageTeams"]))?.locked?.reason ?? "", /Manage permissions/);
  assert.match(pickIntroCta(roles, ctx({ customRoles: 0 }, ["canManagePermissions"]))?.locked?.reason ?? "", /Manage teams/);
});

test("team tabs: boxes for empty Members, Access, Models and Prompts; `?` only for the rest", () => {
  const known = { teams: 1 };
  assert.equal(sizeFor(byKey("team-detail.members"), { ...known, teamMembers: 0 }), "box");
  assert.equal(sizeFor(byKey("team-detail.members"), { ...known, teamMembers: 3 }), null);
  assert.equal(sizeFor(byKey("team-detail.access"), { ...known, plugins: 0 }), "box");
  assert.equal(sizeFor(byKey("team-detail.access"), { ...known }), null);
  assert.equal(sizeFor(byKey("team-detail.models"), { ...known, providers: 0, openworkModels: false }), "box");
  assert.equal(sizeFor(byKey("team-detail.models"), { ...known, providers: 0, openworkModels: true }), null);
  assert.equal(sizeFor(byKey("team-detail.models"), { ...known, providers: 2, openworkModels: false, sharedProviders: 0 }), "banner");
  assert.equal(sizeFor(byKey("team-detail.models"), { ...known, providers: 2, openworkModels: false }), null);
  assert.equal(sizeFor(byKey("team-detail.prompts"), { ...known, hasPrompt: false }), "box");
  assert.equal(sizeFor(byKey("team-detail.prompts"), { ...known, hasPrompt: true }), null);
  for (const key of ["team-detail.role", "team-detail.agents", "team-detail.browser", "team-detail.workbot", "team-detail.desktop"]) {
    assert.equal(sizeFor(byKey(key), { ...known, teamMembers: 0, plugins: 0, hasPrompt: false }), null, key);
  }
});

test("team tab actions respect identity provider teams, Admin teams and permissions", () => {
  const add = byKey("team-detail.members");
  assert.equal(pickIntroCta(add, ctx({ teamMembers: 0 }))?.href, "?tab=overview&addPeople=1");
  assert.match(pickIntroCta(add, ctx({ teamMembers: 0, managedByScim: true }))?.locked?.reason ?? "", /identity provider/);
  assert.match(pickIntroCta(add, ctx({ teamMembers: 0, adminTeam: true }, ["canManageTeams"]))?.locked?.reason ?? "", /Manage Admin teams/);
  const models = byKey("team-detail.models");
  assert.equal(pickIntroCta(models, ctx({ providers: 0 }))?.label, "Add your first AI provider");
  assert.equal(pickIntroCta(models, ctx({ providers: 2, sharedProviders: 0 }))?.label, "Share an AI provider");
  assert.match(pickIntroCta(models, ctx({ providers: 0 }, []))?.locked?.reason ?? "", /Gateway providers/);
  const prompts = byKey("team-detail.prompts");
  assert.equal(pickIntroCta(prompts, ctx({ hasPrompt: false, canEditPrompts: true }))?.href, "?tab=prompts&write=1");
  assert.match(pickIntroCta(prompts, ctx({ hasPrompt: false, canEditPrompts: false }))?.locked?.reason ?? "", /Manage prompts/);
});
