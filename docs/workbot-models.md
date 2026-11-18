# Workbot models and allowance recovery

Included OpenWork models and permission-aware model recovery are generally available in Workbot on cloud and self-hosted deployments. No feature rollout is required.

- Signed-in members can start with included Auto when their deployment and organization permit managed models.
- The member's free allowance remains enforced. Exhaustion preserves the message and shows the reset time; it does not automatically replay the turn.
- Existing paid Models access can authorize paid Luna for a new message in the same conversation. It does not refill Auto's free allowance.
- Purchase and management actions still require the member's current permissions, configured billing and provisioning, an eligible subscription state, and the organization's managed-model policy. Rendering recovery never purchases a subscription.
- Saved custom cloud-agent models remain selected. Membership, exact-model authorization and free/paid routing are rechecked for each turn and retry.
- `INFERENCE_FREE_ENABLED` remains an operational prerequisite for free inference; GA does not enable unconfigured inference or bypass deployment policy.

## Retired rollout settings

`workbotIncludedModels` and `workbotUsageRecovery` no longer control behavior. Stale organization/member overrides and self-hosted operator settings are ignored. Legacy Helm keys remain accepted as retired compatibility inputs, and older client response fields remain fixed true. Neither is a configurable flag.

## Before deploying

The availability change removes both gates; it does not change prices, buy subscriptions, increase allowances or grant billing permissions. Check the live rollout's kill switch and operator lock before interpreting this read-only impact query. It assumes neither is active, and reports active memberships affected by the gate removal; saved model settings and entitlement still determine the actual per-turn route.

```sql
WITH effective AS (
  SELECT m.organization_id,
    COALESCE(mi.enabled, oi.enabled, ri.enabled, 0) AS included_before,
    COALESCE(mu.enabled, ou.enabled, ru.enabled, 0) AS recovery_before
  FROM member m
  LEFT JOIN member_feature mi
    ON mi.member_id = m.id AND mi.feature_key = 'workbotIncludedModels'
  LEFT JOIN member_feature mu
    ON mu.member_id = m.id AND mu.feature_key = 'workbotUsageRecovery'
  LEFT JOIN organization_feature oi
    ON oi.organization_id = m.organization_id AND oi.feature_key = 'workbotIncludedModels'
  LEFT JOIN organization_feature ou
    ON ou.organization_id = m.organization_id AND ou.feature_key = 'workbotUsageRecovery'
  LEFT JOIN feature_rollout ri ON ri.feature_key = 'workbotIncludedModels'
  LEFT JOIN feature_rollout ru ON ru.feature_key = 'workbotUsageRecovery'
  WHERE m.joined_at IS NOT NULL AND m.removed_at IS NULL AND m.user_id IS NOT NULL
)
SELECT
  COUNT(DISTINCT CASE WHEN included_before = 0 AND recovery_before = 0
    THEN organization_id END) AS newly_included_organizations,
  COUNT(DISTINCT CASE WHEN recovery_before = 0
    THEN organization_id END) AS newly_recovery_organizations
FROM effective;
```

Deploy Den API and Workbot from the same revision; the fixed compatibility fields keep supported older clients working. No subscription migration or production-data write is required. Do not enable free inference or change billing configuration as part of this deployment. Verify a free member, exhausted member, billing-capable owner, restricted member and existing paid member against the permission-aware recovery flow. Rollback is a source revert and redeploy; the retired feature switches are not a rollback mechanism.

## Verification

`workbot-model-recovery.api.test.ts` covers actual Den recovery and credentials without flag setup, including disabled managed-model policy, revoked membership and unavailable paid provisioning. The included-model and usage-recovery UI proofs cover saved/reset messages, role isolation, a paid new-message continuation without duplicate execution, retained history and explicit mobile retry after the allowance returns. Their model responses and entitlement activation are synthetic; they do not verify live checkout or provider readiness.
