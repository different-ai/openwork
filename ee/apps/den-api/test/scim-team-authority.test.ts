import assert from "node:assert/strict"
import { test } from "node:test"
import { isAuthoritativeTeamMembership, type TeamMembershipScimFacts } from "@openwork-ee/den-db/permissions"

const manual: TeamMembershipScimFacts = { teamHasScimGroup: false, groupMappingMode: null, listedByIdentityProvider: false, orphanedScimProjection: false }

test("a membership of a team no SCIM group maps carries authority", () => {
  assert.equal(isAuthoritativeTeamMembership(manual), true)
})

test("a membership projected by SCIM stops carrying authority once its group or provider is gone", () => {
  // The provider was deleted (or the group no longer maps the team) but cleanup left the link behind.
  assert.equal(isAuthoritativeTeamMembership({ ...manual, orphanedScimProjection: true }), false)
  // Even when the team is mapped again by another group whose IdP lists nobody.
  assert.equal(isAuthoritativeTeamMembership({ teamHasScimGroup: true, groupMappingMode: "create_teams", listedByIdentityProvider: true, orphanedScimProjection: true }), false)
})

test("someone added by hand to a team whose SCIM provider was deleted keeps the team's grants", () => {
  // Provider cleanup removed the scim_group mapping; no projection link points at this membership.
  assert.equal(isAuthoritativeTeamMembership({ ...manual, teamHasScimGroup: false }), true)
})

test("an IdP-managed team counts only for people the identity provider still lists", () => {
  const created = { ...manual, teamHasScimGroup: true, groupMappingMode: "create_teams" }
  assert.equal(isAuthoritativeTeamMembership({ ...created, listedByIdentityProvider: true }), true)
  assert.equal(isAuthoritativeTeamMembership({ ...created, listedByIdentityProvider: false }), false)
  // Metadata-only mapping leaves membership to Den.
  assert.equal(isAuthoritativeTeamMembership({ ...manual, teamHasScimGroup: true, groupMappingMode: "metadata_only" }), true)
  // A mapped team whose provider row is missing fails closed.
  assert.equal(isAuthoritativeTeamMembership({ ...manual, teamHasScimGroup: true, groupMappingMode: null }), false)
})
