# Native Slack on OpenWork Cloud

Build and demo first; complete Slack Marketplace/RTS distribution approval before public release. This is a platform-owned integration. Cloud customers only click Connect and authorize their own Slack account; Slack workspace administrator approval may be necessary. No per-customer app registration, workspace-ID environment variable, or secret setup is required.

## Platform setup

1. Deploy the branch and migrations through `0132_slack_cloud_installations.sql`, after the shared feature tables in `0129_organization_features.sql`. The deployment must be `DEN_DEPLOYMENT=cloud` and `DEN_ORG_MODE=multi_org`; self-hosted and single-org deployments do not expose the platform app.
2. Configure one OpenWork-owned Slack app. Register the exact callback at the public **API** origin: `/v1/oauth-providers/slack/connect/callback`.
3. Configure the user scope contract below. Set platform credentials through deployment secrets, never the customer Connections settings.
4. In the existing **Admin → Overview → Organizations**, find the intended OpenWork organization and enable **Features → Slack search**. This is the registered `nativeSlack` feature, default-off. The organization's **OpenWork Connect** feature must also allow use.
5. Members connect from Library/Connections. OAuth plus `auth.test` discovers and verifies the workspace and member automatically. An explicit new authorization replaces that member's one workspace slot; background refresh cannot change it.

| Deployment setting | Purpose |
| --- | --- |
| `DEN_DEPLOYMENT=cloud` | Existing feature-system product classification |
| `DEN_ORG_MODE=multi_org` | Hosted multi-organization topology |
| `DEN_SLACK_CLIENT_ID`, `DEN_SLACK_CLIENT_SECRET` | One platform app's confidential OAuth credentials, not availability switches |
| `DEN_API_PUBLIC_URL` | Exact public API origin used for the OAuth callback |
| `DEN_SLACK_SIGNING_SECRET` | App-level signing secret for optional App Home events |

The former `DEN_SLACK_ENABLED` setting no longer enables Slack. Remove it from deployment configuration and use Admin instead; existing accounts are retained but cannot be used while their organization is disabled. There is no Slack-specific flag store, `DEN_SLACK_ORGANIZATION_ID`, `DEN_SLACK_WORKSPACE_ID`, or `DEN_SLACK_BOT_TOKEN`. Leave `DEN_SLACK_API_BASE_URL` and the OAuth URL overrides unset for live Slack; they are development-only synthetic test seams.

## Enable one organization with the existing admin controls

Only a **platform administrator on the Den admin allowlist** can change these controls. Being an owner/admin of a customer organization does not grant platform-admin access.

1. Open `/admin`, then **Organizations**.
2. Filter by the organization's name, slug, or ID.
3. In that organization's **Features** section, check **Slack search**. The state becomes **Set for this organization**. No server restart or environment-variable change is required.
4. Leave other organizations at their default, or explicitly turn the feature off for them. The check is against the calling member's OpenWork organization on each request—not the Slack workspace chosen by the first admin.
5. Use **Use everyone's setting** to remove an override. This means inherit, not off.

The feature registry automatically supplies this row and the existing API/MCP controls. Its persistent state uses `organization_feature` and `feature_rollout`, the same tables as the other features. Credentials and user grants remain in their existing stores.

### Granularity and precedence

- **Per OpenWork organization:** on, off, or inherit. This applies to the organization as a whole; there are no new per-team, per-person, or per-Slack-workspace rollout controls.
- **Deployment-wide default:** `/admin/features` → **Slack search** → **On / Off**. Off still permits an explicit organization opt-in. On still respects an explicit organization opt-out.
- **Emergency stop:** **Turn off everywhere** overrides organization grants and operator locks. **Restore** removes the kill switch; it does not silently change the previous defaults/overrides.
- **Operator locks:** the standard generated `DEN_FEATURE_NATIVE_SLACK` / Helm feature control remains available as part of the shared system, not a required Slack-specific enablement step. A lock disables effective per-organization editing; a kill switch still wins over a forced-on lock.
- **Deployment eligibility:** Cloud-only is declared in `packages/features/src/registry.ts`; an organization override cannot make it available on self-hosted deployments. Single-org topology remains excluded.

The shared order is: deployment exclusion → kill switch → operator lock → organization override → everyone default. The general OpenWork Connect gate and individual Slack consent remain additional requirements. The Slack Assistant and its headless-runtime feature are separate and are not enabled by this switch.

Disabling native Slack blocks subsequent authorization, status, search, thread, and retained capability requests, even when a saved token has not expired. Stored accounts stay available for disconnect; a valid retained grant can resume after re-enabling. A toggle does not cancel already-dispatched Slack requests, uninstall the Slack app, or erase transcripts.

## User permissions

| Category | User scopes | Consent |
| --- | --- | --- |
| Public channels | `search:read.public`, `channels:history` | Required |
| Private channels | `search:read.private`, `groups:history` | Optional |
| DMs | `search:read.im`, `im:history` | Optional |
| Group DMs | `search:read.mpim`, `mpim:history` | Optional |

Declare all scopes in `oauth_config.scopes.user` and the six optional scopes also in `oauth_config.scopes.user_optional`. Members' granted scopes control queries. Public-only consent remains useful limited access; unavailable categories are explicitly omitted, not reported as empty. No file scopes, legacy search, or conversation writes are used.

## App Home

The app has a static Home help surface linking to the Cloud member route `/dashboard/your-connections`. It states read access, no posting/replies, and that account connection is not verified in that view. The same compact view is used for every workspace (DESIGN P1, P5, P7, C3).

Configure `/v1/slack/events` at the public API origin, subscribe only to bot event `app_home_opened`, enable Home and disable Messages/interactivity. There are no user-level message subscriptions. The app signing secret authenticates URL verification and events. OAuth's optional top-level bot grant is stored separately from the member grant, encrypted and keyed by platform client ID plus Slack workspace ID. Home selects only that installation, refreshes rotating bot grants under a row lock, verifies its workspace via `auth.test`, and publishes. The Home handler's publication deadline is two seconds; payloads, provider reads, replay memory, and concurrent publications are bounded. The shared platform-audit middleware records HTTP outcomes after the handler, including rejected requests, and its database writes/retries are outside that deadline. End-to-end acknowledgement latency can therefore exceed two seconds; request evidence is not proof of Home publication and has no tenant attribution from Slack workspace IDs.

Disconnect or a per-organization feature override does not uninstall the Slack workspace's app. Home can continue showing generic connection help: a Slack workspace ID is not an OpenWork organization ID, and the static view does not verify or grant member access. The shared feature's deployment exclusion, kill switch, and forced-off operator lock stop new Home publications. A deployment-wide default of off does not stop this plumbing because individual organizations may be opted in. Signed endpoint verification remains app-level and can run before any organization is enabled; it grants no access and performs no feature-database query. Feature SQL for publication is inside the existing deadline/concurrency accounting, after signature validation; the response deadline does not cancel outstanding SQL work.

Removing the app in Slack revokes its bot token; subsequent publication fails without substituting another workspace's credentials. An installation without a valid bot grant returns `home_unavailable`, while member search can remain usable.

Slack's Home guide requires a bot scope even though `views.publish` lists no method-specific scope. The minimum appropriate Home bot grant and how Slack issues it alongside the user authorization still need live setup verification. Do not add conversation-write permissions just to obtain a token. A synthetic protocol pass does not resolve that provider setup decision.

## Demo and release sequence

The automated journey uses real app-web, agent runtime, Den, its generated admin controls, encrypted storage and capability dispatch with synthetic Slack/model servers. It starts with two organizations disabled despite configured app credentials, enables them separately through Admin, and checks default/override/kill/restore behavior and the ordinary-owner permission boundary. It retains the two Slack workspaces, all four conversation categories, bounded source-linked threads, private-access isolation, partial consent, and blocked-account disconnect proof.

Run `pnpm evals:e2e native-slack-connect --local --engine v2` for the synthetic journey after preparing both pinned engine binaries, Chrome, and owned loopback MySQL/Redis services. The native HTTP fixtures require local placement. The repository now uses E2E journeys rather than package-level unit suites; the earlier protocol and installation-storage unit commands in historical verification receipts are no longer available. The journey does not prove live App Home setup or rotating-grant concurrency; those remain separate activation checks. See [the world notes](../evals/worlds/native-slack-connect.md) and [testing conventions](testing.md).

For a live pre-approval demo, use an eligible internal app and an OpenWork-owned workspace populated with synthetic conversations. Connect two internal members individually, run the same queries, verify source links and inaccessible-private-content behavior, then demonstrate public-only consent. Present this working flow to Slack for distribution/RTS approval. App creation, credentials, activation and outreach are operational steps, not performed by this code change.

Public release still needs Slack distribution/search eligibility, the accepted in-Slack experience, packaged OAuth handoff verification, rotating member-token concurrency checks, and retention/model-processing decisions. OpenWork currently retains normal chat history and Workflow results; this change adds no Slack archive and makes no zero-retention claim.

Primary sources: [RTS eligibility and scopes](https://docs.slack.dev/apis/web-api/real-time-search-api/), [OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [App Home](https://docs.slack.dev/surfaces/app-home/), [signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/). See also [ADR 0002](adr/0002-cloud-slack-before-distribution-approval.md).
