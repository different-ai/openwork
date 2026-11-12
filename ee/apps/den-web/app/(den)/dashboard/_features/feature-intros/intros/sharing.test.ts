import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorSharedBeyondCreator } from "../../../_components/connectors-intro-facts";
import type { MarketplaceAccessGrant } from "../../../_components/marketplace-data";
import { pluginSharedBeyondOwnerWithCollections } from "../../../_components/plugins-intro-facts";

const nobody = { orgWide: false, teamIds: [], memberIds: [] };

test("connector: shared beyond whoever added it, not beyond whoever is looking", () => {
  const onlyAda = { orgWide: false, teamIds: [], memberIds: ["member_ada"] };
  // Ada added it for herself; Ben (an admin) opens it. Before, Ben was told it was shared, or not, by his own id.
  assert.equal(connectorSharedBeyondCreator({ access: onlyAda, createdByOrgMembershipId: "member_ada", createdByYou: false }, "member_ben"), false);
  assert.equal(connectorSharedBeyondCreator({ access: onlyAda, createdByOrgMembershipId: "member_ada", createdByYou: true }, "member_ada"), false);
  // Ada shared it with Ben: shared, whoever looks.
  const adaAndBen = { orgWide: false, teamIds: [], memberIds: ["member_ada", "member_ben"] };
  assert.equal(connectorSharedBeyondCreator({ access: adaAndBen, createdByOrgMembershipId: "member_ada" }, "member_ben"), true);
  assert.equal(connectorSharedBeyondCreator({ access: { ...nobody, teamIds: ["team_1"] }, createdByOrgMembershipId: "member_ada" }, "member_ben"), true);
  // Older servers without the creator id: the viewer's own connector still works; someone else's stays unknown.
  assert.equal(connectorSharedBeyondCreator({ access: onlyAda, createdByYou: true }, "member_ada"), false);
  assert.equal(connectorSharedBeyondCreator({ access: onlyAda, createdByYou: false }, "member_ben"), null);
  // Google Workspace and Microsoft 365 have no access list: everyone's.
  assert.equal(connectorSharedBeyondCreator({ access: null }, "member_ben"), true);
});

function grant(partial: Partial<MarketplaceAccessGrant>): MarketplaceAccessGrant {
  return { id: "grant", orgMembershipId: null, teamId: null, orgWide: false, role: "viewer", createdAt: "2026-11-01T00:00:00.000Z", removedAt: null, ...partial };
}

test("plugin: shared through a collection counts as shared", () => {
  // No grants of its own, but in a collection shared with everyone.
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", [[grant({ orgWide: true })]]), true);
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", [[grant({ teamId: "team_1" })]]), true);
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", [[grant({ orgMembershipId: "member_ben" })]]), true);
  // A collection only its owner can use doesn't share it.
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", [[grant({ orgMembershipId: "member_ada" })], []]), false);
  // Not in any collection, no grants: not shared.
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", []), false);
  // A collection whose access couldn't be read: unknown, so the banner stays hidden...
  assert.equal(pluginSharedBeyondOwnerWithCollections(nobody, "member_ada", [[], null]), null);
  // ...unless something already shares it.
  assert.equal(pluginSharedBeyondOwnerWithCollections({ ...nobody, orgWide: true }, "member_ada", [null]), true);
});
