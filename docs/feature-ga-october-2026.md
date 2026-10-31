# October 2026 rollout graduation

These rollout switches are retired. Their enabled behavior is now the product
on both cloud and self-hosted deployments; a fresh installation needs no
organization override, deployment rollout row, or operator feature lock.

## Generally available

| Area | Retired switches |
| --- | --- |
| Roles and agent policy | `permissions`, `agentPermissions`, `teamRoles`, `sharedRoles` |
| Team and member management | `teamPageTabs`, `desktopPolicyScreenRemoval`, `teamAccessRows`, `memberListToolbars` |
| Workbot | `workbot`, `workbotLunaDefault`, `slackWorkbotReplies` |
| Organization skills | `nativeCloudSkills`, `mcpSkillsExtension` |
| Models | `orgDefaultModel`, `modelRemovalRecovery`, `lastTurnModelFooter` |
| Chat progress | `appBuildProgress`, `backgroundShellTasks` |
| Provider spend limits | `gatewayProviderUsageLimits` |
| Google Docs tools | `googleDocumentTools` |
| Invitations | `inviteLinkVerifiesEmail` |
| Sign-in navigation | `rememberLastOrganization` |
| Team membership lookup | `teamMembershipCache` |
| Cloud-agent models through the AI Gateway | `cloudAgentGateway` |
| Secure keys in chat | `secureSecretFields` |
| Slack Assistant (still needs the Slack connector set up) | `slackAssistant` |
| Workbot sign-in and account connection | `workbotFirstRun`, `workbotInlineConnect` |
| Content-free chat index for admins | `headlessSessionIndex` |
| Automatic OpenCode v2 migration | `engineV2Upgrade`, `engineV2ForceUpgrade` |

## Automatic OpenCode v2 migration

Existing v1 installations copy their chats with a backup and move to OpenCode v2
when idle; fresh installations start on v2. This is default product behavior,
not an opt-in rollout. Organization and member overrides, killed rollout rows,
and operator feature locks cannot stop migration or revert a migrated profile.
Older desktop and worker clients still receive `enginePolicy: { upgrade: true }`.
Cloud bootstrap sends positive compatibility signals on every launch, wake and
checkpoint restore; it never rewrites engine state itself.

## Folded into another switch

| Retired switch | Now controlled by |
| --- | --- |
| `workbotGuidedNavigation` | `workbotWorkspaceAssistant` |
| `headlessStepTurns` | Saved step turns (generally available, including `headlessDurableTurns`) |

The remaining switches stay off by default. An old override for a folded key
does not turn on its new switch.

## Removed with their feature

`workbotTeamLinks` (Workbot's team settings links), `remoteSessionEvents` (MCP
resource subscriptions for remote session receipts; poll with
`remote-session:status` instead), and the deprecated `modelsAnalyticsUi` and
`taskAnalyticsUi` screens with the API routes only they used.

Removing a rollout does not remove authorization, connector consent, model
availability checks, or operator configuration. Self-hosted installations must
still configure their model providers, runner services and OAuth integrations.
Luna is never represented as available without a verified authorized model.
Older stored overrides and feature environment variables for these keys no
longer control behavior. Old Helm values remain accepted for upgrade
compatibility, but are ignored.

## Managed deployments remain opt-in

`managedDeploymentsGcp` and `managedDeploymentsMcp` are folded into
`managedDeployments`. That single switch remains **cloud-only and off by
default**; it controls AWS, Google Cloud and deployment agent tools together.
An old GCP or MCP override cannot enable the parent rollout. Installer
publication and provider configuration remain separate operator requirements.
Disabling the parent blocks launches without deleting resources or interrupting
authenticated installer enrollment or health reports.

Self-hosted installations can use the generally available product features, but
cannot use this hosted control-plane rollout to provision more installations.
Other switches that were not globally enabled are not graduated by this change.


## Durable turns and per-chat cells

`headlessDurableTurns` and `headlessSessionCells` are now generally available on cloud and self-hosted.
Their registry entries, organization checks, Helm keys and off paths are removed. Legacy disabled overrides,
killed rollout rows and operator locks do not disable them. Resume grants retain callback authentication,
turn binding, membership checks, expiry, revocation and rate limits; service configuration is still required.

Den returns `stepTurns: true` and `sessionCells: true` for older clients. Workbot continues treating missing
optional fields from older Dens as false. Existing turns keep their persisted execution mode; existing sessions
remain readable and move only through lossless split logic and forwarding. Owner-shared memory, legacy history,
and fallback event transports remain intact. Deploy a compatible runner before the GA Den.

## Additional GA features (October 30)

These rollouts were enabled in Cloud on October 29. They are now retired: the
enabled paths are unconditional on cloud and self-hosted, except sandbox
organization administration remains cloud-only. Old disabled overrides, killed
rows and operator feature locks no longer turn them off.

| Area | Retired switches |
| --- | --- |
| AI Gateway providers | `gatewayProviderTest`, `gatewayProviderAuthErrors`, `providerCredentialStatus`, `gatewayProviderRemovalLimits`, `liveProviderSync` |
| Connect | `customConnectorSetup`, `expandedMcpPresets`, `guidedSlackSetup`, `slackSendAsBot`, `libraryConnectorOrgSetup` |
| Library | `libraryConnectorNavigation`, `libraryDetailBreadcrumbs` |
| Browser and remote tasks | `browserFloatingView`, `remoteSessionSubagents`, `remoteSessionThreadView`, `remoteSessionAnswers` |
| Everyday use | `mermaidZoom`, `activationChecklist`, `mcpAppLibraries`, `nativeAffordanceCodeMode`, `analyticsDailyTrends` |
| Platform admin (cloud only) | `sandboxOrgs` |

Features that still need setup keep needing it: Slack messages from the OpenWork
bot and guided Slack setup need the OpenWork app in Slack, and tasks on other
computers need a connected computer.

`sessionTokenHashing` is also retired: Den hashes newly issued session tokens
without a feature flag and continues reading compatible existing tokens. Upgrade
all replicas to a version that reads hashed tokens before introducing this
release into a self-hosted rolling deployment; pre-October-23 replicas cannot
read them. There is no token-storage rollback switch.

## Chat, Artifacts and Automation schedules (October 30)

These six rollout switches are also retired on cloud and self-hosted. Their
behavior is unconditional, with no organization feature overrides:

| Area | Retired switches |
| --- | --- |
| Model shown while a reply streams | `liveReplyModel` |
| Agents above the composer | `composerSubagentTracker` |
| Text-first chat activity | `textActivityRail` |
| List-first Artifacts with retained live views | `artifactsListFirst` |
| Every-few-hours Automation schedules | `automationIntervalSchedules` |
| Meeting-based Automation triggers | `automationCalendarTriggers` |

Old disabled overrides, killed rollout rows and operator feature locks no
longer opt organizations out. Rendering GA does not change stored chat data
or App permissions. Scheduling GA does not bypass Automation access checks,
runner configuration, calendar authorization or connector consent.

`remoteSessionHelperView` remains a separate opt-in rollout. Its Agents list
prerequisite is now generally available and needs no tracker override. All
other unlisted flags retain their existing behavior.
