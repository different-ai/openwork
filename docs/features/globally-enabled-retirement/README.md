# Retire the remaining globally enabled rollouts

This second pass retires 18 temporary rollout gates that were enabled for everyone in Cloud and not killed at audit time. Their old `default: false` entries lagged behind the actual rollout; that stale default is not a reason to preserve a completed rollout. The enabled implementation becomes standard on both Cloud and self-hosted deployments, as declared by each feature's existing deployment scope.

The first pass retired 37 other switches. See [the original retirement guide](../ga-rollout-retirement/README.md) for that history. This is code retirement, not a change to production rollout rows, and opening or merging its PR is not proof that every production replica or installed desktop is running it.

## Retired keys

| Area | Keys |
| --- | --- |
| Models | `claudeAgentProvider`, `localModelsPolicy`, `shareDeviceProvider`, `singleOpenWorkModelsRow` |
| Sign-in and administration | `webPerMember`, `passwordSignInGoogle`, `signInEmailSync`, `ssoOidcSetupCheck`, `denPageConsistency` |
| Workbot | `workbotScrollToBottom`, `workbotApps`, `workbotProactive`, `workbotTeamSettings`, `workbotUsageAnalytics` |
| Computer access and inventory | `remoteDevices`, `remoteSessionAccess` |
| Dictation and file sharing | `nativeDictation`, `fileSendPermissions` |

## What retirement does not remove

- Web seat assignment, entitlement checks, billing calculations and permissions. Per-member Web remains the standard rule; retirement must not turn Web on for unassigned members or charge them as assigned.
- The actual local-model policy and device-specific OpenWork Models enable/disable setting.
- Provider-sharing authorization, confirmation, credential validation and audit behavior.
- Identity verification, account-linking protections, session freshness and organization SSO policy.
- Microphone and speech-recognition OS permissions, platform support checks and the person's start/stop controls.
- File-sharing Allow/Ask/Block policy, remembered-grant revocation and recipient/folder boundaries.
- Your agent's real organization/team enablement, member opt-out/snooze/mute, data-source permissions, message limits and working hours. The separate experimental brief, check-gate and send-check rollouts are unchanged.
- Computer ownership, visibility, organization remote-access policy, per-device consent and trusted-host checks. `remoteComputers` and `remoteTasksOptIn` are separate, retained rollouts; GA inventory does not grant remote control.

No historical rollout, override, usage, outcome or audit data is deleted. Retired Helm keys and older admin inputs remain accepted and ignored. Fixed response-only compatibility fields keep supported older clients on the GA path without retaining configurable switches. New clients must not gate behavior on those compatibility fields.

## Pre-deploy read-only comparison

The following comparison was run during this pass on Cloud. Results remain private. Refresh it immediately before deployment: a globally enabled rollout does not prove that no organization or member intentionally disabled it.

All 18 previous code defaults were 0. The after-state is available on both deployments, subject to the real permissions/settings described above. Operator locks have higher precedence than organization/member overrides, so inspect the deployment's locks and kill switches first. A Cloud comparison does not cover a self-hosted installation.

```sql
WITH retiring AS (
  SELECT 'claudeAgentProvider' AS feature_key
  UNION ALL SELECT 'webPerMember'
  UNION ALL SELECT 'localModelsPolicy'
  UNION ALL SELECT 'shareDeviceProvider'
  UNION ALL SELECT 'singleOpenWorkModelsRow'
  UNION ALL SELECT 'passwordSignInGoogle'
  UNION ALL SELECT 'signInEmailSync'
  UNION ALL SELECT 'ssoOidcSetupCheck'
  UNION ALL SELECT 'denPageConsistency'
  UNION ALL SELECT 'nativeDictation'
  UNION ALL SELECT 'workbotScrollToBottom'
  UNION ALL SELECT 'workbotApps'
  UNION ALL SELECT 'workbotProactive'
  UNION ALL SELECT 'workbotTeamSettings'
  UNION ALL SELECT 'workbotUsageAnalytics'
  UNION ALL SELECT 'fileSendPermissions'
  UNION ALL SELECT 'remoteDevices'
  UNION ALL SELECT 'remoteSessionAccess'
), subjects AS (
  SELECT id AS organization_id, NULL AS member_id FROM organization
  UNION ALL
  SELECT organization_id, id AS member_id FROM member WHERE joined_at IS NOT NULL
), resolved AS (
  SELECT s.organization_id, s.member_id, f.feature_key,
    CASE WHEN COALESCE(r.killed, 0) = 1 THEN 0
      ELSE COALESCE(m.enabled, o.enabled, r.enabled, 0) END AS before_enabled
  FROM subjects s CROSS JOIN retiring f
  LEFT JOIN feature_rollout r ON r.feature_key = f.feature_key
  LEFT JOIN organization_feature o
    ON o.organization_id = s.organization_id AND o.feature_key = f.feature_key
  LEFT JOIN member_feature m
    ON m.member_id = s.member_id AND m.feature_key = f.feature_key
)
SELECT * FROM resolved WHERE before_enabled = 0;
```

Review every intentionally disabled subject before deployment; do not silently erase a safety decision or automatically rewrite overrides. Self-hosted operators must review the removal of their `config.features` / `DEN_FEATURE_*` locks. In particular, features that previously started off on a fresh self-hosted deployment now use the GA implementation, while actual policy, billing and consent checks still apply.

## Deployment and verification

1. Run the comparison and resolve any intentionally disabled subjects. Keep results out of this public repository.
2. Deploy the Den API and verify the new revision starts, passes health checks and actually becomes live. A successful build or merge is not sufficient.
3. Verify the admin feature list omits all 18 keys; older client compatibility fields must not reintroduce editable admin rows.
4. Deploy Den web, Workbot, runner and Desktop changes. Verify older supported clients still receive fixed compatibility values and actual permission/entitlement checks remain effective.
5. Use real journeys to verify Web assignment, model/device settings, account sign-in, file-sharing approvals, computer consent and Your agent's explicit off/snooze settings.

No production rollout write, data migration, secret change, forced enablement of an experimental flag, or installer publication is part of this cleanup.

## Rollback

Revert the code retirement to restore the gates; historical state remains stored. After retirement these 18 behaviors have no independent rollout kill switch. Their real settings, access policies and stop controls remain available.
