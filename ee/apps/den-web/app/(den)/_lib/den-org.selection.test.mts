// Runnable check for the org-selection decision. No test framework in den-web,
// so this is a plain assert script: `node den-org.selection.test.mts`.
import assert from "node:assert/strict";
import { shouldOfferOrgSelection, shouldRequireOrgSelection } from "./den-org.ts";
import type { DenOrgSummary } from "./den-org.ts";

function org(id: string, isActive: boolean): DenOrgSummary {
  return {
    id, name: id, slug: id, logo: null, metadata: null, role: "member",
    orgMemberId: `m-${id}`, membershipId: `ms-${id}`, memberCount: 1,
    createdAt: null, updatedAt: null, isActive,
  };
}

// multiple orgs + none active => picker
assert.equal(shouldRequireOrgSelection([org("a", false), org("b", false)]), true);
// multiple orgs + one active => no picker (dashboard loads active)
assert.equal(shouldRequireOrgSelection([org("a", true), org("b", false)]), false);
// multiple orgs + one active => post-login can still offer explicit selection
assert.equal(shouldOfferOrgSelection([org("a", true), org("b", false)]), true);
// single org + not active => auto-select, no picker
assert.equal(shouldRequireOrgSelection([org("a", false)]), false);
assert.equal(shouldOfferOrgSelection([org("a", false)]), false);
// no orgs => no picker (routes to create/join)
assert.equal(shouldRequireOrgSelection([]), false);

console.log("ok: den-org selection predicate");
