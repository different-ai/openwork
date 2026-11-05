import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload } from "../../../../_lib/den-org";
import { libraryIntroFacts } from "../../../_components/library-intro-facts";
import type { LibraryItem } from "../../../_components/library-data";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroPermission } from "../types";
import { LIBRARY_TAB_INTROS, type LibraryFacts, libraryIntros } from "./library";

const orgContext = parseOrgContextPayload({
  organization: { id: "org_1", name: "Acme", slug: "acme" },
  currentMember: { id: "member_1", userId: "user_1", role: "member", isOwner: false },
});
assert.ok(orgContext);
const memberContext = orgContext;

function ctx(facts: LibraryFacts, permissions: readonly FeatureIntroPermission[] = []): FeatureIntroContext {
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: memberContext,
    access: getOrgAccessFlags("member", false),
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

function intro(key: string): FeatureIntro {
  const found = libraryIntros.find((entry) => entry.key === key);
  assert.ok(found, key);
  return found;
}

const section = intro("library");

function sizeFor(entry: FeatureIntro, facts: LibraryFacts) {
  return selectIntroSize({
    state: entry.setupState(ctx(facts)),
    parentState: entry.parent ? section.setupState(ctx(facts)) : null,
  })?.size ?? null;
}

function connector(id: string): LibraryItem {
  return { type: "connection", id, name: id, url: "https://linear.app", description: null, transport: "mcp", provider: null, state: "connected", connectedAt: null, edges: [] };
}

function plugin(id: string, componentKinds: string[]): LibraryItem {
  return { type: "plugin", id, name: id, description: null, componentCount: componentKinds.length, componentKinds, sourceRepositoryUrl: null, edges: [], role: "viewer" };
}

function workflow(id: string): LibraryItem {
  return {
    type: "workflow", id, plugin: null, name: id, description: null, role: "viewer", edges: [], state: "ready", resultState: "never_run",
    latestSuccessfulAt: null, failureReason: null, viewState: "default", activeViewTitle: null, automationCount: 0, source: { kind: "created" },
  };
}

test("library intros match the page, each ?show= tab and the setup pages", () => {
  const search = (value: string) => new URLSearchParams(value);
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", null)?.key, "library");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", search("show=connectors"))?.key, "library.connectors");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", search("show=skills"))?.key, "library.skills");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", search("show=plugins"))?.key, "library.plugins");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", search("show=models"))?.key, "library.models");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library", search("show=other"))?.key, "library");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library/connectors/new", null)?.key, "library.connectors.add");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library/plugins/new", search("start=skill"))?.key, "library.plugins.new");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library/model-providers/new", null)?.key, "library.models.key");
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library/connectors/c_1/share", null)?.key, "library.share");
  // An item's own page is not an empty state.
  assert.equal(matchFeatureIntro(libraryIntros, "/dashboard/library/connectors/c_1", null), null);
  assert.deepEqual(Object.values(LIBRARY_TAB_INTROS), ["library.connectors", "library.skills", "library.plugins", "library.models"]);
});

test("facts count what the Library shows, null until everything loaded", () => {
  assert.equal(libraryIntroFacts({ items: undefined, models: 0, personalModels: 0 }), null);
  assert.equal(libraryIntroFacts({ items: [], models: undefined, personalModels: 0 }), null);
  assert.equal(libraryIntroFacts({ items: [], models: 0, personalModels: undefined }), null);
  assert.deepEqual(libraryIntroFacts({ items: [], models: 0, personalModels: 0 }), { items: 0, connectors: 0, skills: 0, plugins: 0, models: 0 });
  const items = [
    connector("c1"),
    connector("c1"),
    plugin("p1", ["skill"]),
    plugin("p2", ["skill", "command"]),
    workflow("w1"),
  ];
  assert.deepEqual(libraryIntroFacts({ items, models: 2, personalModels: 1 }), { items: 7, connectors: 1, skills: 1, plugins: 1, models: 3 });
});

test("full screen with nothing at all, a box per empty tab, nothing on a guess", () => {
  const empty = { items: 0, connectors: 0, skills: 0, plugins: 0, models: 0 };
  assert.equal(sizeFor(section, empty), "fullscreen");
  assert.equal(sizeFor(section, {}), null);
  assert.equal(sizeFor(section, { ...empty, items: 1, models: 1 }), null);
  // An empty Library takes the tabs over with the section intro.
  assert.equal(sizeFor(intro("library.skills"), empty), "fullscreen");
  const someModels = { items: 2, connectors: 0, skills: 0, plugins: 0, models: 2 };
  assert.equal(sizeFor(intro("library.connectors"), someModels), "box");
  assert.equal(sizeFor(intro("library.skills"), someModels), "box");
  assert.equal(sizeFor(intro("library.plugins"), someModels), "box");
  assert.equal(sizeFor(intro("library.models"), someModels), null);
  assert.equal(sizeFor(intro("library.models"), { items: 1, connectors: 1, skills: 0, plugins: 0, models: 0 }), "box");
  assert.equal(sizeFor(intro("library.connectors"), { items: 1 }), null);
  for (const key of ["library.connectors.add", "library.plugins.new", "library.models.key", "library.share"]) {
    assert.equal(sizeFor(intro(key), empty), null, key);
  }
});

test("members get the Library's own forms; admins can add for the team", () => {
  const empty = { items: 0, connectors: 0, skills: 0, plugins: 0, models: 0 };
  const member = pickIntroCta(section, ctx(empty));
  assert.equal(member?.href, "/dashboard/library/connectors/new");
  assert.equal(member?.locked, undefined);
  assert.equal(member?.note?.(ctx(empty)), "Only you can use it until you share it.");
  assert.equal(pickIntroCta(section, ctx(empty, ["canManageConnections"]))?.href, "/dashboard/mcp-connections/new");
  assert.equal(pickIntroCta(intro("library.skills"), ctx(empty))?.href, "/dashboard/library/plugins/new?start=skill");
  assert.equal(pickIntroCta(intro("library.plugins"), ctx(empty))?.href, "/dashboard/library/plugins/new");
  assert.equal(pickIntroCta(intro("library.models"), ctx(empty))?.href, "/dashboard/library/model-providers/new");
  assert.equal(pickIntroCta(intro("library.models"), ctx(empty, ["canManageGatewayProviders"]))?.label, "Add an AI provider for your team");
  // No intro here offers a locked action: every member can do each of them.
  for (const entry of libraryIntros) {
    for (const cta of entry.ctas) assert.equal(cta.locked, undefined, entry.key);
  }
});
