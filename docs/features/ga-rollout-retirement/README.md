# Completed rollout retirement

This cleanup retires 37 temporary switches whose registry default is on and whose Cloud deployment rollout was enabled, available and not killed at audit time. It preserves the enabled implementation, not the off-state fallback. A globally enabled flag with a false registry default is **not** automatically classified as GA.

## Retired switches

- Connect: `googleCalendarRecurrence`, `googleDrivePdfText`, `desktopPersonalConnectors`, `outlookAttachments`.
- Artifacts: `appToolRepair`, `publicApps`, `appSites`.
- Desktop: `plainFreeModel`, `settledSessions`, `composerBackgroundTasks`, `agentQuestions`, `steadyLiveTurn`, `remoteSessionPush`.
- Administration and security: `ssoPerOrganization`, `superAdminPermissionSet`, `browserUploadPermissions`, `agentHarnessPermissions`.
- Computer and browser: `computerUse`, `computerSessionHistory`, `parallelComputerUse`, `browserUse`, `standardCodeMode`.
- Workbot: `workbotDriveFiles`, `workbotAccountMenu`, `workbotBrowserChat`, `workbotInstantOpen`, `workbotBrowserRecovery`, `workbotQuickReply`, `workbotWorkingStatus`, `workbotCenteredProfile`, `workbotBrowserPreview`, `workbotProfileSheet`, `workbotRemoteTasks`, `workbotProfileNav`, `workbotQuietCalendar`, `workbotSlackAnswerReply`.
- Sandboxes: `sandboxMicrosoft365`.

Browser recovery and sandbox Microsoft 365 remain **Cloud only**. Removing their rollout switch must not enable either on self-hosted deployments. All other retired features were available on both deployments.

## What remains enforced

GA does not mean unrestricted. Authentication, membership, roles, public-artifact eligibility, Web entitlements, organization and team settings, file-sharing approvals, computer access policies, native OS permissions and configured-provider requirements remain enforced. Removing a security feature's rollout gate makes its policy enforcement standard; it must not remove the policy itself.

`standardCodeMode` no longer chooses an interpreter by rollout. Previously saved Workflows still use their recorded interpreter; retirement does not rewrite them.

The 42 remaining flags are default-off rollouts or operational controls. This change does not enable them, change production rollout rows or promote them based solely on their age. In particular, managed deployments and administrator recovery remain separately controlled.

## Compatibility

Retired keys remain in `RETIRED_FEATURE_KEYS`, so old admin inputs and Helm values are accepted and ignored rather than breaking upgrades. They are absent from the active registry and control plane and cannot gate new clients. Historical rollout, override, audit and usage rows are not deleted.

An older client may still expect a feature response key and interpret its absence as off. Fixed, response-only compatibility values keep those clients on the GA behavior; these are not adjustable rollouts and must not bypass actual browser/computer access checks. Keep existing compatibility responses during the transition. Deploy and verify the Den API, Den web, Workbot, runner and Desktop changes together, including older loaded UI bundles.

## Required production dry run before deployment

The deployment-wide audit is **not** an organization/member override audit. A read-only Cloud comparison using the query below was completed during this cleanup. Production results remain private. Before merging or deploying, refresh that comparison on each deployment to identify any subjects whose effective state would change; a previous Cloud check does not cover self-hosted operator locks or later changes. Do not treat local tests or globally enabled rollouts alone as proof of unchanged access.

The following query covers all 37 keys on Cloud. The previous default is 1 for each. On self-hosted deployments remove `workbotBrowserRecovery` and `sandboxMicrosoft365` from the CTE: their after-state stays off. Deployment-wide and operator-locked states must be checked first; an installation with operator locks must apply those locks before member and organization overrides.

```sql
WITH retiring AS (
  SELECT 'googleCalendarRecurrence' AS feature_key
  UNION ALL SELECT 'googleDrivePdfText'
  UNION ALL SELECT 'plainFreeModel'
  UNION ALL SELECT 'settledSessions'
  UNION ALL SELECT 'appToolRepair'
  UNION ALL SELECT 'publicApps'
  UNION ALL SELECT 'appSites'
  UNION ALL SELECT 'composerBackgroundTasks'
  UNION ALL SELECT 'agentQuestions'
  UNION ALL SELECT 'steadyLiveTurn'
  UNION ALL SELECT 'ssoPerOrganization'
  UNION ALL SELECT 'superAdminPermissionSet'
  UNION ALL SELECT 'desktopPersonalConnectors'
  UNION ALL SELECT 'workbotDriveFiles'
  UNION ALL SELECT 'workbotAccountMenu'
  UNION ALL SELECT 'workbotBrowserChat'
  UNION ALL SELECT 'workbotInstantOpen'
  UNION ALL SELECT 'workbotBrowserRecovery'
  UNION ALL SELECT 'workbotQuickReply'
  UNION ALL SELECT 'workbotWorkingStatus'
  UNION ALL SELECT 'workbotCenteredProfile'
  UNION ALL SELECT 'workbotBrowserPreview'
  UNION ALL SELECT 'workbotProfileSheet'
  UNION ALL SELECT 'workbotRemoteTasks'
  UNION ALL SELECT 'workbotProfileNav'
  UNION ALL SELECT 'workbotQuietCalendar'
  UNION ALL SELECT 'workbotSlackAnswerReply'
  UNION ALL SELECT 'browserUploadPermissions'
  UNION ALL SELECT 'agentHarnessPermissions'
  UNION ALL SELECT 'computerUse'
  UNION ALL SELECT 'computerSessionHistory'
  UNION ALL SELECT 'parallelComputerUse'
  UNION ALL SELECT 'browserUse'
  UNION ALL SELECT 'remoteSessionPush'
  UNION ALL SELECT 'sandboxMicrosoft365'
  UNION ALL SELECT 'standardCodeMode'
  UNION ALL SELECT 'outlookAttachments'
), subjects AS (
  SELECT id AS organization_id, NULL AS member_id FROM organization
  UNION ALL
  SELECT organization_id, id AS member_id FROM member WHERE joined_at IS NOT NULL
), resolved AS (
  SELECT s.organization_id, s.member_id, f.feature_key,
    CASE WHEN COALESCE(r.killed, 0) = 1 THEN 0
      ELSE COALESCE(m.enabled, o.enabled, r.enabled, 1) END AS before_enabled
  FROM subjects s CROSS JOIN retiring f
  LEFT JOIN feature_rollout r ON r.feature_key = f.feature_key
  LEFT JOIN organization_feature o
    ON o.organization_id = s.organization_id AND o.feature_key = f.feature_key
  LEFT JOIN member_feature m
    ON m.member_id = s.member_id AND m.feature_key = f.feature_key
)
SELECT * FROM resolved WHERE before_enabled = 0;
```

Keep all results private. Review every intentionally disabled subject before rollout; removing a gate must not silently bypass a safety decision. Do not automatically change overrides or delete their history. Refresh this comparison immediately before deployment.

## Verification

- Feature registry tests, including retirement and ignored operator-lock regression coverage, pass. The two new retirement tests fail against the original registry and pass after cleanup.
- Desktop app, local server, Den API, Den web and Workbot typechecks pass on Node 24.22.1.
- Focused computer-control, API/security, Workbot and Den tests pass, including response-only compatibility checks.
- `pnpm features:check`, `pnpm check:node-source-imports` and `git diff --check` pass.
- `pnpm den:contract` succeeds using a disposable local MySQL database and temporary account, both cleaned up. Generated OpenAPI and SDK outputs remain ignored.
- Full E2E verification is **incomplete**. The account-menu proof was skipped under its default placement; the headless Desktop smoke reached only the startup overlay, not a usable feature journey. These are not counted as passes.
- `pnpm --dir evals typecheck` still fails at `evals/proofs/local-models-policy.proof.test.ts:70` because `timeoutMs` is not a `ClickOptions` property. The same command and error were reproduced on a clean control at the base revision `4980ef5beb`; that unrelated proof is unchanged.

## Rollback

Revert this code change to restore the switches and their checks. Their historical database state remains available. After retirement there is no per-feature kill switch for these 37 behaviors; operational settings and actual access policies remain in effect.

## Flags intentionally retained

These entries all still have `default: false`. Promotion requires a separate rollout decision; this audit does not infer GA from a production override.

| Key | Feature |
| --- | --- |
| `remoteDesktopDeviceLogin` | Remote desktop device sign-in |
| `claudeAgentProvider` | Claude Code sign-in |
| `webPerMember` | OpenWork Web per member |
| `localModelsPolicy` | AI Gateway: limit local models (Ollama, LM Studio) |
| `shareDeviceProvider` | Desktop: share a provider key with your organization |
| `singleOpenWorkModelsRow` | Desktop: one OpenWork Models row you can turn off |
| `followUpSuggestions` | Desktop: suggested follow-ups |
| `passwordSignInGoogle` | Sign-in: offer Google alongside a password |
| `signInEmailSync` | Sign-in: account email follows Google or SSO |
| `ssoOidcSetupCheck` | SSO: check the OIDC issuer during setup |
| `denGreySidebar` | Den: grey sidebar, white pages |
| `denPageConsistency` | Den: predictable page interactions |
| `teamSettingsSidebar` | Den: team sections in a sidebar |
| `administratorRecovery` | Deploy-time administrator recovery |
| `nativeDictation` | Native dictation |
| `connectionMcpServers` | Connect: an MCP server for each connection |
| `opencodeV2Only` | OpenCode v2 only |
| `managedDeployments` | Managed deployments |
| `workbotDocuments` | Workbot Documents |
| `workbotDocumentEditing` | Workbot Documents: editing |
| `workbotWorkspaceAssistant` | Workbot: workspace assistant |
| `workbotScrollToBottom` | Workbot: scroll to latest messages |
| `workbotProfileComputers` | Workbot: Computers in its profile |
| `workbotApps` | Workbot: open artifacts from chat |
| `workbotCalmChat` | Workbot: calm chat look |
| `workbotProactive` | Workbot: Your agent |
| `workbotAgentBrief` | Workbot: Your agent's brief and check rhythm |
| `workbotAgentCheckGate` | Workbot: Your agent skips checks when nothing new arrived |
| `workbotAgentSendCheck` | Workbot: Your agent checks each message before sending |
| `workbotSettingsTabs` | Workbot: settings in tabs |
| `workbotTeamSettings` | Workbot: settings per team |
| `workbotUsageAnalytics` | Workbot: cost in Analytics |
| `fileSendPermissions` | Connected accounts: one permission for files the agent sends |
| `browserDemonstrations` | Workbot: teach browser tasks |
| `remoteComputers` | Desktop: computer use on remote computers |
| `remoteDevices` | Computers |
| `remoteSessionAccess` | Desktop: other devices can open sessions started on a computer |
| `remoteTasksOptIn` | Desktop: other devices reach a computer only after its owner allows it |
| `sandboxGateway` | Workbot: computers through the sandbox gateway |
| `sandboxSlack` | Sandboxes: sample Slack for Workbot |
| `connectStandardTools` | Connect: standard tools |
| `connectEngineTools` | Connect: a tool for each action in OpenWork's engine |
