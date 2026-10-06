import assert from "node:assert/strict"
import { test } from "node:test"

// Loading the legacy registrations pulls in the real modules they call, which
// read env at import. These placeholders never reach a database or network.
const placeholders: Record<string, string> = {
  DEN_BASE_URL: "http://localhost:3005",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/core_hooks_test",
  DEN_DB_ENCRYPTION_KEY: "core-hooks-test-db-encryption-key-not-a-secret-1234567890",
  BETTER_AUTH_SECRET: "core-hooks-test-auth-secret-not-a-secret!!",
  OPENWORK_DEV_MODE: "1",
}
for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value
}

// Reviewers: a diff here is an ordering or membership change of a Core hook.
const expected = {
  "invitation.accepted": ["legacy/teams/assign-invitation-team"],
  "invitation.cancelGuard": ["legacy/teams/admin-team-invitation-cancel"],
  "invitation.createGuard": ["legacy/teams/admin-team-invitation-refresh"],
  "member.added": [
    "legacy/ai-gateway/mint-member-key-for-adapter-insert",
    "legacy/openwork-models/sync-inference-after-member-added",
    "legacy/billing/seat-quantity-after-member-added",
    "legacy/billing/inference-quantity-after-member-added",
    "legacy/billing/web-quantity-after-member-added",
  ],
  "member.removalGuard": ["legacy/teams/admin-team-member-removal"],
  "member.removed": [
    "legacy/openwork-models/sync-inference-after-member-removed",
    "legacy/billing/seat-quantity-after-member-removed",
    "legacy/billing/inference-quantity-after-member-removed",
    "legacy/billing/web-quantity-after-member-removed",
  ],
  "member.removing": [
    "legacy/ai-gateway/revoke-member-inference-credentials",
    "legacy/connect-native-providers/delete-member-connected-accounts",
    "legacy/custom-providers/delete-member-credentials",
    "legacy/teams/delete-member-team-memberships",
    "legacy/enterprise-auth-scim/unlink-member-group-projections",
    "legacy/custom-providers/delete-member-provider-access",
    "legacy/desktop-policies/delete-member-assignments",
    "legacy/connect/delete-member-connection-grants",
    "legacy/marketplace/remove-member-marketplace-grants",
    "legacy/marketplace/remove-member-config-object-grants",
    "legacy/marketplace/remove-member-plugin-grants",
    "legacy/marketplace-github-sync/remove-member-connector-grants",
    "legacy/dashboards/remove-member-dashboard-grants",
  ],
  "org.created": [
    "legacy/ai-gateway/mint-owner-key",
    "legacy/desktop-policies/ensure-default-policy",
  ],
  "team.deleting": [
    "legacy/ai-gateway/invalidate-deleted-team-inference-oauth",
    "legacy/ai-gateway/delete-team-provider-access",
    "legacy/desktop-policies/delete-team-assignments",
    "legacy/connect/delete-team-connection-grants",
    "legacy/custom-providers/delete-team-provider-access",
    "legacy/marketplace/remove-team-marketplace-grants",
    "legacy/marketplace/remove-team-config-object-grants",
    "legacy/marketplace/remove-team-plugin-grants",
    "legacy/marketplace-github-sync/remove-team-connector-grants",
  ],
  "team.membershipChanged": ["legacy/ai-gateway/invalidate-team-inference-oauth"],
  "team.mutationGuard": ["legacy/enterprise-auth-scim/refuse-scim-managed-team-mutation"],
  "user.deleting": [
    "legacy/ai-gateway/expire-member-usage-requests",
    "legacy/ai-gateway/revoke-deleted-user-inference-credentials",
    "legacy/enterprise-auth-sso/delete-user-external-identities",
    "legacy/enterprise-auth-scim/delete-user-sync-events",
    "legacy/openwork-web/detach-deleted-user-workers",
  ],
}

test("legacy registrations reproduce today's hook order", async () => {
  const { describeCoreHooks } = await import("../src/core/hooks/index.js")
  assert.deepEqual(describeCoreHooks(), expected)
})
