# GA feature retirement

## Scope

Retire completed rollout gates, preserving their enabled behavior:

- Library: `libraryDetailBreadcrumbs`, `libraryConnectorNavigation`, `libraryConnectorOrgSetup`
- Desktop: `nativeAffordanceCodeMode`, `mermaidZoom`, `liveProviderSync`, `browserFloatingView`, `remoteSessionSubagents`, `remoteSessionThreadView`, `remoteSessionAnswers`, `activationChecklist`
- Connect: `mcpAppLibraries`, `slackSendAsBot`, `customConnectorSetup`, `expandedMcpPresets`, `guidedSlackSetup`
- AI Gateway: `gatewayProviderTest`, `gatewayProviderAuthErrors`, `providerCredentialStatus`, `gatewayProviderRemovalLimits`
- Administration: `sandboxOrgs`, `analyticsDailyTrends`, `sessionTokenHashing`
- Automations: `automationIntervalSchedules`, `automationCalendarTriggers` — every-few-hours and before/after-meetings schedules are always on. Cloud placement, the headless runner, Google Calendar calendar scope and the Desktop/Cloud (`automationTargetAllowed`) toggle remain enforced without a flag. The schedule-kind negotiation for released desktops (`x-openwork-automation-schedule-kinds`) stays, so older desktops still do not receive kinds they cannot parse.

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

## Local verification

- Node `24.22.1`: `pnpm --filter @openwork/features test` — 22 passed, zero failures/skips. The same updated regression suite against a detached `0dcf407af6` control gives 21 passed / 1 expected failure (`libraryDetailBreadcrumbs` is still active on the baseline). Temporary control worktree removed.
- Node `24.22.1`: `pnpm features:check` — passed (registry, generated Helm values/schema and guard rules).
- Node `24.22.1`: `pnpm check:ui-guardrails` — zero new violations.
- Node `24.22.1`: `pnpm --filter @openwork-ee/den-web typecheck` — passed.
- Helm render with legacy `libraryDetailBreadcrumbs=false`, `sessionTokenHashing=false` and `sandboxOrgs=false` values — passed; old values files still validate.
- Independent read-only review found no actionable safety bugs in registry, Den web or client compatibility boundaries.
- The Library navigation proof expected obsolete list-style skill disclosures. Keep the compact list preview-free and verify skill content only after opening its detail page. The breadcrumb proof now waits for the actual current-page crumb rather than a category button also present in the background. No list-preview UI was added.
- App/server/plugin, Den API and Workbot typechecks passed on Node `24.22.1`.
- Focused API/Workbot checks — 216 passed, zero skipped. Full Den provider unit suite — 1,229 passed, zero failures/skips. Fixed its inherited upload-relay expiry fixture by controlling the test clock and explicitly asserting expiry blocks Microsoft requests. The clean `0dcf407af6` control reproduced the original 1,227 passed / 1 failed result. The full API security suite passes against an isolated native MySQL 8.4 instance: 315 passed, zero failures/skips, with Node and MySQL in UTC to match CI. Fixture session lookups use the stored token digest while request principals retain the caller's real token; freshness setup asserts it changed exactly one row.
- Desktop/plugin focused unit checks — plugin suite 147 passed; server suite 19 passed; app UI suite 43 passed; ownership/breadcrumb/Mermaid/instruction suite 41 passed. Native binary integration fixtures were updated but not executed.
- Den web focused unit checks — 89 passed, zero failures/skips; Den web lint passed.
- Evals static checks — spec lint passed (122 files), browser callback check passed (430 callbacks), and layer lint passed (1,049 modules).
- Fixed four inherited eval typing errors after reproducing identical diagnostics against a clean detached `0dcf407af6` control: preserve immutable connection IDs across callbacks, use an erasable constructor, and await the reset disposer. Node `24.22.1`: `pnpm -C evals typecheck` and `pnpm -C evals check` now pass (473 source files, 122 specs, no lint errors).
- Docker could not start its MySQL health check (`no space left on device`). No Docker data was pruned or deleted. API runtime verification instead used a newly initialized, isolated native MySQL 8.4 instance with only fictional throwaway databases. Browser and packaged-binary verification is owned by PR CI and its commit-bound evidence report.
