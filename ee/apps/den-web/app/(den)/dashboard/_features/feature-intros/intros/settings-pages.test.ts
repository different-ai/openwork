import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgAccessFlags } from "../../../../_lib/den-org";
import { collectionsIntroFacts, isBuiltInCollection } from "../../../_components/collections-intro-facts";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroFacts, FeatureIntroPermission } from "../types";
import { apiKeysIntros } from "./api-keys";
import { collectionsIntros } from "./collections";
import { deploymentsIntros } from "./deployments";
import { FEATURE_INTROS, getFeatureIntro } from "./index";
import { settingsIntros } from "./settings";
import { toolTesterIntros } from "./tool-tester";

function orgContext(entitlements: Record<string, boolean> = {}) {
  const parsed = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
    entitlements,
  });
  assert.ok(parsed);
  return parsed;
}

function ctx(facts: FeatureIntroFacts, permissions: readonly FeatureIntroPermission[], entitlements: Record<string, boolean> = {}): FeatureIntroContext {
  const access: DenOrgAccessFlags = getOrgAccessFlags("member", false);
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: orgContext(entitlements),
    access,
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

function intro(key: string): FeatureIntro {
  const found = FEATURE_INTROS.find((entry) => entry.key === key);
  assert.ok(found, key);
  return found;
}

function sizeFor(entry: FeatureIntro, facts: FeatureIntroFacts, parentFacts: FeatureIntroFacts | null = null) {
  const parent = entry.parent ? getFeatureIntro(entry.parent) : null;
  const parentState = parent ? parent.setupState(ctx({ ...parentFacts, ...facts }, [])) : null;
  return selectIntroSize({ state: entry.setupState(ctx(facts, [])), parentState })?.size ?? null;
}

test("every page matches its intro", () => {
  const all = [...apiKeysIntros, ...collectionsIntros, ...deploymentsIntros, ...settingsIntros, ...toolTesterIntros];
  const at = (path: string) => matchFeatureIntro(all, path, null)?.key;
  assert.equal(at("/dashboard/api-keys"), "api-keys");
  assert.equal(at("/dashboard/marketplaces"), "collections");
  assert.equal(at("/dashboard/marketplaces/mkt_1"), "collections.plugins");
  assert.equal(at("/dashboard/deployments"), "deployments");
  assert.equal(at("/dashboard/org-settings"), "org-settings");
  assert.equal(at("/dashboard/diagnostics"), "diagnostics");
  assert.equal(at("/dashboard/billing"), "billing");
  assert.equal(at("/dashboard/desktop-policies"), "desktop-policies");
  assert.equal(at("/dashboard/tool-tester"), "connectors.tool-tester");
});

test("form and report pages are help only: never shown on the page", () => {
  for (const key of ["org-settings", "diagnostics", "billing", "desktop-policies"]) {
    const entry = intro(key);
    assert.equal(entry.helpOnly, true, key);
    assert.equal(sizeFor(entry, {}), null, key);
  }
});

test("desktop policies never promise more than model access", () => {
  const text = JSON.stringify(intro("desktop-policies").highlights);
  assert.match(text, /doesn.t apply them yet/);
  assert.match(pickIntroCta(intro("desktop-policies"), ctx({}, ["canManageDesktopPolicies"], { desktopPolicies: false }))?.locked?.reason ?? "", /Enterprise plan/);
  assert.equal(pickIntroCta(intro("desktop-policies"), ctx({}, ["canManageDesktopPolicies"], { desktopPolicies: true }))?.href, "/dashboard/desktop-policies/new");
  assert.ok(pickIntroCta(intro("desktop-policies"), ctx({}, [], { desktopPolicies: true }))?.locked);
});

test("API keys: full screen with none, nothing while loading or once one exists", () => {
  const entry = intro("api-keys");
  assert.equal(sizeFor(entry, {}), null);
  assert.equal(sizeFor(entry, { apiKeys: 0 }), "fullscreen");
  assert.equal(sizeFor(entry, { apiKeys: 2 }), null);
  assert.equal(pickIntroCta(entry, ctx({ apiKeys: 0 }, ["canManageApiKeys"]))?.href, "/dashboard/api-keys?new=1");
  assert.match(pickIntroCta(entry, ctx({ apiKeys: 0 }, []))?.locked?.reason ?? "", /API keys|API Keys|permission/);
});

test("collections: built-in one is not the organization's own", () => {
  assert.equal(isBuiltInCollection({ name: "OpenWork Marketplace", logoUrl: "/openwork-mark.svg" }), true);
  assert.equal(isBuiltInCollection({ name: "OpenWork Marketplace", logoUrl: null }), false);
  assert.equal(collectionsIntroFacts(undefined), null);
  assert.deepEqual(
    collectionsIntroFacts([{ name: "OpenWork Marketplace", logoUrl: "/openwork-mark.svg" }, { name: "Sales", logoUrl: null }]),
    { collections: 2, ownCollections: 1 },
  );
});

test("collections: full screen with none, banner with only the built-in one, box on an empty collection", () => {
  const list = intro("collections");
  assert.equal(sizeFor(list, {}), null);
  assert.equal(sizeFor(list, { collections: 0, ownCollections: 0 }), "fullscreen");
  assert.equal(sizeFor(list, { collections: 1, ownCollections: 0 }), "banner");
  assert.equal(sizeFor(list, { collections: 2, ownCollections: 1 }), null);
  assert.equal(pickIntroCta(list, ctx({}, ["canManageMarketplaces"]))?.href, "/dashboard/marketplaces?new=1");
  assert.ok(pickIntroCta(list, ctx({}, []))?.locked);

  const plugins = intro("collections.plugins");
  // The collection page clears what the list reported, so an earlier "none" never takes it over.
  assert.equal(sizeFor(plugins, { collectionPlugins: 0, collections: null, ownCollections: null }, { collections: 0, ownCollections: 0 }), "box");
  assert.equal(sizeFor(plugins, { collectionPlugins: 3 }), null);
  assert.equal(pickIntroCta(plugins, ctx({ canAddPlugins: true }, []))?.href, "?addPlugin=1");
  assert.ok(pickIntroCta(plugins, ctx({ canAddPlugins: false }, []))?.locked);
});

test("deployments: full screen with none; locked until a cloud installer is ready", () => {
  const entry = intro("deployments");
  assert.equal(sizeFor(entry, {}), null);
  assert.equal(sizeFor(entry, { deployments: 0, cloudReady: true }), "fullscreen");
  assert.equal(sizeFor(entry, { deployments: 1, cloudReady: true }), null);
  assert.equal(pickIntroCta(entry, ctx({ cloudReady: true }, ["canManageDeployments"]))?.href, "/dashboard/deployments?new=1");
  assert.match(pickIntroCta(entry, ctx({ cloudReady: false }, ["canManageDeployments"]))?.locked?.reason ?? "", /operator/);
  assert.ok(pickIntroCta(entry, ctx({ cloudReady: true }, []))?.locked);
});

test("tool tester: Connectors full screen with no connector, box with none testable", () => {
  const entry = intro("connectors.tool-tester");
  assert.equal(sizeFor(entry, { connectors: 0, testableConnectors: 0 }), "fullscreen");
  assert.equal(sizeFor(entry, { connectors: 3, testableConnectors: 0 }), "box");
  assert.equal(sizeFor(entry, { connectors: 3, testableConnectors: 1 }), null);
  assert.equal(pickIntroCta(entry, ctx({}, ["canManageConnections"]))?.href, "/dashboard/mcp-connections");
});
