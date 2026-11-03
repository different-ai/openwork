# Consolidated Your agent, browser and computer rollouts

These are three independent features, not one combined computer/browser switch:

| Retained feature | Included behavior | Retired independent switches |
| --- | --- | --- |
| `workbotProactive` | Your agent checks, aggregate admin health, My bot, preferences and undo | `workbotAgentHealthView`, `workbotAgentLibrary` |
| `browserUse` | Workbot browser tools and page-only live view with tabs and takeover | `browserLiveView` |
| `computerUse` | Computer tools and background interaction for supported Mac apps | `computerUseBackground` |

All three retain their existing author, deployments (cloud and self-hosted), default off, organization/member overrides, and kill switches. Child switches no longer affect behavior. Historical audit and usage rows remain untouched. Retired Helm keys remain accepted but ignored, so existing values files still install.

## Before deploying

Run this read-only check against each deployment. It returns only organizations or memberships whose parent is on while a child is off (a newly included surface). Inspect `den_list_features` first: this query accounts for rollout state but not operator locks; on an installation with locks, evaluate those locks before member/organization overrides. No results does not prove that a future rollout is appropriate.

```sql
WITH pairs AS (
  SELECT 'workbotProactive' AS parent_key, 'workbotAgentHealthView' AS child_key
  UNION ALL SELECT 'workbotProactive', 'workbotAgentLibrary'
  UNION ALL SELECT 'browserUse', 'browserLiveView'
  UNION ALL SELECT 'computerUse', 'computerUseBackground'
), subjects AS (
  SELECT id AS organization_id, NULL AS member_id FROM organization
  UNION ALL
  SELECT organization_id, id AS member_id FROM member WHERE joined_at IS NOT NULL
), resolved AS (
  SELECT s.organization_id, s.member_id, p.parent_key, p.child_key,
    CASE WHEN COALESCE(pr.killed, 0) = 1 THEN 0
      ELSE COALESCE(pm.enabled, po.enabled, pr.enabled, 0) END AS parent_enabled,
    CASE WHEN COALESCE(cr.killed, 0) = 1 THEN 0
      ELSE COALESCE(cm.enabled, co.enabled, cr.enabled, 0) END AS child_enabled
  FROM subjects s CROSS JOIN pairs p
  LEFT JOIN feature_rollout pr ON pr.feature_key = p.parent_key
  LEFT JOIN feature_rollout cr ON cr.feature_key = p.child_key
  LEFT JOIN organization_feature po ON po.organization_id = s.organization_id AND po.feature_key = p.parent_key
  LEFT JOIN organization_feature co ON co.organization_id = s.organization_id AND co.feature_key = p.child_key
  LEFT JOIN member_feature pm ON pm.member_id = s.member_id AND pm.feature_key = p.parent_key
  LEFT JOIN member_feature cm ON cm.member_id = s.member_id AND cm.feature_key = p.child_key
)
SELECT * FROM resolved WHERE parent_enabled = 1 AND child_enabled = 0;
```

Keep production results out of the public repository. If a child is intentionally off under an enabled parent, decide whether to enable the whole parent bundle or disable the parent before deploying. Do not automatically OR child overrides into the parent: that can enable tools or background checks for someone who never had them.

Self-hosted operators must review and remove retired `config.features` / `DEN_FEATURE_*` child locks. The parent now controls the whole bundle, including when an old child lock was false.

Deploy Den API and its generated contract first, then Den web, Workbot and Desktop. Mixed-version clients must be considered when rolling out; stale clients that still expect child feature keys may hide a surface until updated. No new database migration or production rollout write is needed. Refresh the read-only comparison immediately before deploy.

## Revert

Use the retained parent's kill switch to disable its whole bundle. To restore independent child rollouts, revert the code change; existing historical child overrides have not been deleted. Turning off a parent does not delete user preferences, checks, conversations or cloud computers, and does not silently grant structured-tool permission to GUI input.
