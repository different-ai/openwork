# GA feature retirement

## Scope

Retire completed rollout gates, preserving their enabled behavior:

- Library: `libraryDetailBreadcrumbs`, `libraryConnectorNavigation`, `libraryConnectorOrgSetup`
- Desktop: `nativeAffordanceCodeMode`, `mermaidZoom`, `liveProviderSync`, `browserFloatingView`, `remoteSessionSubagents`, `remoteSessionThreadView`, `remoteSessionAnswers`, `activationChecklist`
- Connect: `mcpAppLibraries`, `slackSendAsBot`, `customConnectorSetup`, `expandedMcpPresets`, `guidedSlackSetup`
- AI Gateway: `gatewayProviderTest`, `gatewayProviderAuthErrors`, `providerCredentialStatus`, `gatewayProviderRemovalLimits`
- Administration: `sandboxOrgs`, `analyticsDailyTrends`, `sessionTokenHashing`

Keep `composerSubagentTracker` and all other active rollouts. Sandbox organizations remain cloud-only. Sign-in token hashing retains compatibility with existing sessions. Retired keys remain accepted-and-ignored in legacy feature override input and Helm values; historical database records are not deleted.

## Read-only pre-deploy checks

Read `den_list_features` and verify every candidate remains enabled, not killed and not operator-locked. Re-run this read-only query before deployment:

```sql
WITH disabled AS (
  SELECT feature_key, 'organization' AS scope FROM organization_feature WHERE enabled = 0
  UNION ALL
  SELECT feature_key, 'member' AS scope FROM member_feature WHERE enabled = 0
)
SELECT feature_key, scope, COUNT(*) AS disabled_overrides
FROM disabled
WHERE feature_key IN (
  'libraryDetailBreadcrumbs', 'nativeAffordanceCodeMode', 'libraryConnectorNavigation',
  'mcpAppLibraries', 'gatewayProviderTest', 'mermaidZoom', 'sandboxOrgs',
  'slackSendAsBot', 'liveProviderSync', 'browserFloatingView', 'remoteSessionSubagents',
  'remoteSessionThreadView', 'remoteSessionAnswers', 'activationChecklist',
  'gatewayProviderAuthErrors', 'providerCredentialStatus', 'sessionTokenHashing',
  'customConnectorSetup', 'expandedMcpPresets', 'analyticsDailyTrends',
  'gatewayProviderRemovalLimits', 'guidedSlackSetup', 'libraryConnectorOrgSetup'
)
GROUP BY feature_key, scope;
```

If it returns rows for a candidate, stop and preserve its switch until the opt-out is explicitly resolved. Production query results and organization identifiers do not belong in this public report.

## Rollout and rollback

No production feature state or stored overrides are changed by this cleanup. The API keeps deprecated response-only compatibility values for published clients that interpret missing keys as off; these are not configurable registry/admin switches. Remove that compatibility shim only after those clients are no longer supported. New clients use the GA behavior without a feature response. Self-hosted operators should review retired locks: they no longer disable GA functionality.

After the gates are removed, rollback is a code revert and redeploy, not the retired kill switches. Preserve existing deployment boundaries, authorization and plan checks.

## Verification

- Node `24.22.1`: `pnpm --filter @openwork/features test` — 22 passed, zero failures/skips. The same updated regression suite against a detached `0dcf407af6` control gives 21 passed / 1 expected failure (`libraryDetailBreadcrumbs` is still active on the baseline). Temporary control worktree removed.
- Node `24.22.1`: `pnpm features:check` — passed (registry, generated Helm values/schema and guard rules).
- Node `24.22.1`: `pnpm check:ui-guardrails` — zero new violations.
- Node `24.22.1`: `pnpm --filter @openwork-ee/den-web typecheck` — passed.
- Helm render with legacy `libraryDetailBreadcrumbs=false`, `sessionTokenHashing=false` and `sandboxOrgs=false` values — passed; old values files still validate.
- Independent read-only review found no actionable safety bugs in registry, Den web or client compatibility boundaries.
- App/server/plugin, Den API and Workbot typechecks passed on Node `24.22.1`.
- Focused API/Workbot checks — 216 passed, zero skipped. API runtime tests requiring MySQL were not run.
- Desktop/plugin focused unit checks — plugin suite 147 passed; server suite 19 passed; app UI suite 43 passed; ownership/breadcrumb/Mermaid/instruction suite 41 passed. Native binary integration fixtures were updated but not executed.
- Den web focused unit checks — 89 passed, zero failures/skips; Den web lint passed.
- Evals static checks — spec lint passed (122 files), browser callback check passed (430 callbacks), and layer lint passed (1,049 modules).
- Evals typecheck remains failed with four pre-existing errors. The exact Node `24.22.1` command `pnpm -C evals typecheck` exits 1 on both this branch and a clean detached `0dcf407af6` control, with matching diagnostics at `revised-custom-connector-flows.proof.test.ts:127,153`, `den-super-admin-upgrade.ts:65` and `computer-window-approval.ts:26`; no additional branch errors.
- Full API/browser integration verification is incomplete. `pnpm dev:den:mysql` exited 1 with an unhealthy MySQL container. Docker health inspection reports `OCI runtime exec failed: ... no space left on device`. No Docker data was pruned or deleted.
