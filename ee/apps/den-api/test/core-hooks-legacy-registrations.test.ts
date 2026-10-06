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
    "legacy/ai-gateway/re-revoke-member-credentials-after-removal",
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
  "org.deletion.post": ["legacy/web-origins/invalidate-approval-cache"],
  "org.deletion.pre": ["legacy/billing/cancel-organization-subscriptions"],
  "org.deletion.purge": [
    "legacy/ai-gateway/erase-organization-usage",
    "legacy/analytics/erase-organization-models-analytics",
    "legacy/ai-gateway/revoke-organization-google-credentials",
    "legacy/connect-native-providers/revoke-organization-google-workspace-accounts",
    "legacy/install-links/purge-organization-install-links",
    "legacy/openwork-web/purge-organization-workers",
    "legacy/teams/purge-organization-teams",
    "legacy/enterprise-auth-scim/purge-organization-scim",
    "legacy/ai-gateway/purge-organization-providers",
    "legacy/openwork-models/purge-organization-inference",
    "legacy/free-inference/purge-organization-free-usage",
    "legacy/custom-providers/purge-organization-providers",
    "legacy/branding/purge-organization-brand-assets",
    "legacy/workspace-bootstrap/purge-organization-workspace-claims",
    "legacy/enterprise-auth-sso/purge-organization-sso",
    "legacy/audit-logs/purge-organization-audit",
    "legacy/billing/purge-organization-subscriptions",
    "legacy/desktop-policies/purge-organization-policies",
    "legacy/diagnostics/purge-organization-diagnostic-credentials",
    "legacy/web-origins/purge-organization-web-origins",
    "legacy/slack-assistant/purge-organization-slack-assistant",
    "legacy/connect-native-providers/purge-organization-connected-accounts",
    "legacy/connect/purge-organization-connections",
    "legacy/marketplace-github-sync/purge-organization-connectors",
    "legacy/marketplace/purge-organization-marketplace",
    "legacy/automations/purge-organization-automations",
    "legacy/workflows/purge-organization-workflow-runs",
    "legacy/remote-sessions/purge-organization-remote-sessions",
    "legacy/dashboards/purge-organization-dashboards",
    "legacy/retired-generated-views/purge-organization-generated-views",
  ],
  "team.deleting": [
    "legacy/ai-gateway/invalidate-deleted-team-inference-oauth",
    "legacy/ai-gateway/delete-team-provider-access",
    "legacy/ai-gateway/delete-team-usage-assignments",
    "legacy/desktop-policies/delete-team-assignments",
    "legacy/connect/delete-team-connection-grants",
    "legacy/custom-providers/delete-team-provider-access",
    "legacy/marketplace/remove-team-marketplace-grants",
    "legacy/marketplace/remove-team-config-object-grants",
    "legacy/marketplace/remove-team-plugin-grants",
    "legacy/marketplace-github-sync/remove-team-connector-grants",
    "legacy/dashboards/remove-team-dashboard-grants",
  ],
  "team.membershipChanged": ["legacy/ai-gateway/invalidate-team-inference-oauth"],
  "team.mutationGuard": ["legacy/enterprise-auth-scim/refuse-scim-managed-team-mutation"],
  "user.deleting": [
    "legacy/ai-gateway/expire-member-usage-requests",
    "legacy/ai-gateway/revoke-deleted-user-inference-credentials",
    "legacy/connect-native-providers/delete-deleted-user-connected-accounts",
    "legacy/custom-providers/delete-deleted-user-credentials",
    "legacy/enterprise-auth-sso/delete-user-external-identities",
    "legacy/enterprise-auth-scim/delete-user-sync-events",
    "legacy/openwork-web/detach-deleted-user-workers",
  ],
}

test("legacy registrations reproduce today's hook order", async () => {
  const { describeCoreHooks } = await import("../src/core/hooks/index.js")
  assert.deepEqual(describeCoreHooks(), expected)
})

// W0-P10 / README R1: these revocations run whatever the module state. A
// module plan that moves one into its manifest must keep `security: true`.
const requiredSecurityHooks = {
  "member.removed": ["legacy/ai-gateway/re-revoke-member-credentials-after-removal"],
  "member.removing": [
    "legacy/ai-gateway/revoke-member-inference-credentials",
    "legacy/connect-native-providers/delete-member-connected-accounts",
    "legacy/custom-providers/delete-member-credentials",
  ],
  "org.deletion.purge": [
    "legacy/ai-gateway/revoke-organization-google-credentials",
    "legacy/connect-native-providers/revoke-organization-google-workspace-accounts",
  ],
  "team.deleting": ["legacy/ai-gateway/invalidate-deleted-team-inference-oauth"],
  "team.membershipChanged": ["legacy/ai-gateway/invalidate-team-inference-oauth"],
  // R1 "deprovision blocks": SCIM-managed teams refuse Den edits even when SCIM is off.
  "team.mutationGuard": ["legacy/enterprise-auth-scim/refuse-scim-managed-team-mutation"],
  "user.deleting": [
    "legacy/ai-gateway/revoke-deleted-user-inference-credentials",
    "legacy/connect-native-providers/delete-deleted-user-connected-accounts",
    "legacy/custom-providers/delete-deleted-user-credentials",
  ],
}

test("member, team, user and org revocations are security hooks", async () => {
  const { describeCoreSecurityHooks } = await import("../src/core/hooks/index.js")
  assert.deepEqual(describeCoreSecurityHooks(), requiredSecurityHooks)
})
