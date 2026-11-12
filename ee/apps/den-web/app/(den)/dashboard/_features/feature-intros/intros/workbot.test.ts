import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgContext } from "../../../../_lib/den-org";
import { workbotIntroFacts } from "../../../_components/workbot-intro-facts";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntroContext, FeatureIntroPermission } from "../types";
import { type WorkbotFacts, workbotIntros } from "./workbot";

const [section] = workbotIntros;

function orgContext(workbot: boolean): DenOrgContext {
  const context = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
    capabilities: { workbot },
  });
  assert.ok(context);
  return context;
}

function ctx(
  facts: WorkbotFacts,
  permissions: readonly FeatureIntroPermission[] = ["canManageGatewayProviders", "canManageModelsSettings"],
  workbot = true,
): FeatureIntroContext {
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: orgContext(workbot),
    access: getOrgAccessFlags("member", false),
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

const noProvider = { gatewayRequired: true, hasGatewayProvider: false };

test("the Workbot intro covers Manage › Workbot", () => {
  assert.equal(matchFeatureIntro(workbotIntros, "/dashboard/workbot-settings", null)?.key, "workbot");
  assert.equal(matchFeatureIntro(workbotIntros, "/workbot", null), null);
});

test("facts come from the saved model and the Workbot readiness check", () => {
  assert.equal(workbotIntroFacts({ deployed: true, settings: undefined, readiness: noProvider }), null);
  assert.equal(workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: undefined }), null);
  assert.deepEqual(workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: noProvider }), { modelChosen: false, needsProvider: true });
  assert.deepEqual(
    workbotIntroFacts({ deployed: true, settings: { model: "gw/model" }, readiness: { gatewayRequired: true, hasGatewayProvider: true } }),
    { modelChosen: true, needsProvider: false },
  );
  // Included models: no provider needed.
  assert.deepEqual(workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: { gatewayRequired: false, hasGatewayProvider: false } }), { modelChosen: false, needsProvider: false });
  // Admin B's own free allowance is blocked by a team policy, but the workspace's members don't need a provider.
  assert.deepEqual(
    workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: { gatewayRequired: true, hasGatewayProvider: false, organizationGatewayRequired: false } }),
    { modelChosen: false, needsProvider: false },
  );
  // And the other way round: this admin is fine, the workspace still needs a provider.
  assert.deepEqual(
    workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: { gatewayRequired: false, hasGatewayProvider: false, organizationGatewayRequired: true } }),
    { modelChosen: false, needsProvider: true },
  );
  // An admin turned Workbot off for this person: said only then, so every other answer is unchanged.
  assert.deepEqual(
    workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: { gatewayRequired: false, hasGatewayProvider: false, enabled: false } }),
    { modelChosen: false, needsProvider: false, workbotOff: true },
  );
  assert.deepEqual(
    workbotIntroFacts({ deployed: true, settings: { model: null }, readiness: { gatewayRequired: false, hasGatewayProvider: false, enabled: true } }),
    { modelChosen: false, needsProvider: false },
  );
  // Workbot not deployed here: never replaces the page, and needs no readiness check.
  assert.deepEqual(workbotIntroFacts({ deployed: false, settings: { model: null }, readiness: undefined }), { modelChosen: false, needsProvider: false });
});

test("full screen only when Workbot has nothing to answer with, never on a guess", () => {
  const size = (facts: WorkbotFacts) => selectIntroSize({ state: section.setupState(ctx(facts)), parentState: null })?.size ?? null;
  assert.equal(size({}), null);
  assert.equal(size({ modelChosen: false }), null);
  assert.equal(size({ modelChosen: false, needsProvider: true }), "fullscreen");
  // The built-in default is set up: choosing it saves nothing, so it can't be what clears the intro.
  assert.equal(size({ modelChosen: false, needsProvider: false }), null);
  // A saved model stays on the page, where the admin can change it.
  assert.equal(size({ modelChosen: true, needsProvider: true }), null);
});

test("actions follow permissions, never offering what can't be done", () => {
  const unusable = { modelChosen: false, needsProvider: true };
  assert.equal(pickIntroCta(section, ctx(unusable))?.href, "/dashboard/ai-gateway/providers/new");
  assert.equal(pickIntroCta(section, ctx(unusable))?.locked, undefined);
  assert.match(pickIntroCta(section, ctx(unusable, ["canManageModelsSettings"]))?.locked?.reason ?? "", /needs an AI provider/);

  const ready = { modelChosen: false, needsProvider: false };
  assert.equal(pickIntroCta(section, ctx(ready))?.href, "#workbot-default-model");
  assert.equal(pickIntroCta(section, ctx(ready, []))?.label, "Open Workbot");
  assert.equal(pickIntroCta(section, ctx(ready, []))?.href, "/workbot");
  assert.ok(pickIntroCta(section, ctx(ready, [], false))?.locked);
  // Workbot is off for this person: Open Workbot stays, locked, with who can turn it on.
  const off = pickIntroCta(section, ctx({ ...ready, workbotOff: true }, []));
  assert.equal(off?.label, "Open Workbot");
  assert.match(off?.locked?.reason ?? "", /Workbot is off for your team\. An admin can turn it on in Members › Teams\./);
  // Someone who manages Workbot's settings still gets their own action.
  assert.equal(pickIntroCta(section, ctx({ ...ready, workbotOff: true }))?.href, "#workbot-default-model");
  assert.ok(pickIntroCta(section, ctx({ modelChosen: true, needsProvider: true }, []))?.locked);
});
