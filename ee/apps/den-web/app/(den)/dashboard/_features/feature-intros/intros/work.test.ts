import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgContext } from "../../../../_lib/den-org";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroFacts, FeatureIntroPermission } from "../types";
import { type AutomationsFacts, automationsIntros } from "./automations";
import { homeIntros } from "./home";

const [automations] = automationsIntros;
const work = [...automationsIntros, ...homeIntros];

function orgWith(openworkWeb: boolean): DenOrgContext {
  const parsed = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "member_1", userId: "user_1", role: "member", isOwner: false },
    capabilities: { openworkWeb },
  });
  assert.ok(parsed);
  return parsed;
}

function ctx(facts: FeatureIntroFacts, permissions: readonly FeatureIntroPermission[] = [], openworkWeb = false): FeatureIntroContext {
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: orgWith(openworkWeb),
    access: getOrgAccessFlags("member", false),
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

function size(intro: FeatureIntro, facts: FeatureIntroFacts) {
  return selectIntroSize({ state: intro.setupState(ctx(facts)), parentState: null })?.size ?? null;
}

test("work intros match their pages", () => {
  assert.equal(matchFeatureIntro(work, "/dashboard/automations", null)?.key, "automations");
  assert.equal(matchFeatureIntro(work, "/dashboard/automations", new URLSearchParams("automation=a_1"))?.key, "automations");
  assert.equal(matchFeatureIntro(work, "/dashboard", null)?.key, "home");
  assert.equal(matchFeatureIntro(work, "/dashboard/web", null)?.key, "web");
  assert.equal(matchFeatureIntro(work, "/dashboard/my-bot", null)?.key, "my-bot");
});

test("My Automations takes the page only once the list loaded empty", () => {
  const facts = (value: AutomationsFacts) => value;
  assert.equal(size(automations, facts({})), null);
  assert.equal(size(automations, facts({ automations: 0 })), "fullscreen");
  assert.equal(size(automations, facts({ automations: 2 })), null);
});

test("Automations points to the app, and to OpenWork Web where the organization has it", () => {
  const plain = pickIntroCta(automations, ctx({ automations: 0 }));
  assert.equal(plain?.href, "/install");
  assert.equal(plain?.note, undefined);
  const withWeb = ctx({ automations: 0 }, [], true);
  assert.match(pickIntroCta(automations, withWeb)?.note?.(withWeb) ?? "", /OpenWork Web/);
});

test("Home, OpenWork Web and My bot answer `?` only, never take the page", () => {
  for (const intro of homeIntros) {
    assert.equal(size(intro, {}), null, intro.key);
    for (const cta of intro.ctas) assert.equal(cta.locked, undefined, intro.key);
  }
  const home = homeIntros.find((intro) => intro.key === "home");
  assert.ok(home);
  assert.equal(pickIntroCta(home, ctx({}, ["canInviteMembers"]))?.label, "Invite your team");
  assert.equal(pickIntroCta(home, ctx({}))?.href, "/install");
});
