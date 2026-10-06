# Native Slack on OpenWork Cloud

Build and demo first; complete Slack Marketplace/RTS distribution approval before public release. This is a platform-owned integration. Cloud customers only click Connect and authorize their own Slack account; Slack workspace administrator approval may be necessary. No per-customer app registration, workspace-ID environment variable, or secret setup is required.

## Platform setup

1. Deploy the branch and migration `0129_slack_cloud_installations.sql` to a controlled Cloud demo environment. `DEN_ORG_MODE` must be `multi_org`; single-org enterprise hosting does not expose the platform app.
2. Configure one OpenWork-owned Slack app. Register the exact callback at the public **API** origin: `/v1/oauth-providers/slack/connect/callback`.
3. Configure the user scope contract below. Set platform credentials through deployment secrets, never the customer Connections settings.
4. Enable `DEN_SLACK_ENABLED` only on the intended demo/release deployment and ensure organization Connect policy allows use. This flag is default-off. It makes native Slack available to all organizations on that Cloud deployment; it is not a per-workspace eligibility check.
5. Members connect from Library/Connections. OAuth plus `auth.test` discovers and verifies the workspace and member automatically. An explicit new authorization replaces that member's one workspace slot; background refresh cannot change it.

| Deployment setting | Purpose |
| --- | --- |
| `DEN_SLACK_ENABLED` | Default-off platform release switch |
| `DEN_ORG_MODE=multi_org` | Hosted Cloud mode |
| `DEN_SLACK_CLIENT_ID`, `DEN_SLACK_CLIENT_SECRET` | One platform app's confidential OAuth credentials |
| `DEN_API_PUBLIC_URL` | Exact public API origin used for the OAuth callback |
| `DEN_SLACK_SIGNING_SECRET` | App-level signing secret for optional App Home events |

There is no `DEN_SLACK_ORGANIZATION_ID`, `DEN_SLACK_WORKSPACE_ID`, or `DEN_SLACK_BOT_TOKEN`. Leave `DEN_SLACK_API_BASE_URL` and the OAuth URL overrides unset for live Slack; they are development-only synthetic test seams.

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

Configure `/v1/slack/events` at the public API origin, subscribe only to bot event `app_home_opened`, enable Home and disable Messages/interactivity. There are no user-level message subscriptions. The app signing secret authenticates URL verification and events. OAuth's optional top-level bot grant is stored separately from the member grant, encrypted and keyed by platform client ID plus Slack workspace ID. Home selects only that installation, refreshes rotating bot grants under a row lock, verifies its workspace via `auth.test`, and publishes. The total response deadline is two seconds; payloads, provider reads, replay memory, and concurrent publications are bounded.

Disconnect removes a member's read grant, not the workspace's installed app. Home can continue showing generic connection help. Removing the app in Slack revokes its bot token; subsequent publication fails without substituting another workspace's credentials. An installation without a valid bot grant returns `home_unavailable`, while member search can remain usable.

Slack's Home guide requires a bot scope even though `views.publish` lists no method-specific scope. The minimum appropriate Home bot grant and how Slack issues it alongside the user authorization still need live setup verification. Do not add conversation-write permissions just to obtain a token. A synthetic protocol pass does not resolve that provider setup decision.

## Demo and release sequence

The automated journey uses real app-web, agent runtime, Den, encrypted storage and capability dispatch with synthetic Slack/model servers. It demonstrates two Slack workspaces and two Cloud organizations with one platform configuration, all four conversation categories, bounded source-linked threads, private-access isolation, partial consent, and disable/disconnect behavior.

Run `pnpm evals:e2e native-slack-connect --local --engine v2` for the synthetic journey after preparing both pinned engine binaries, Chrome, and owned loopback MySQL/Redis services. The native HTTP fixtures require local placement. The repository now uses E2E journeys rather than package-level unit suites; the earlier protocol and installation-storage unit commands in historical verification receipts are no longer available. The journey does not prove live App Home setup or rotating-grant concurrency; those remain separate activation checks. See [the world notes](../evals/worlds/native-slack-connect.md) and [testing conventions](testing.md).

For a live pre-approval demo, use an eligible internal app and an OpenWork-owned workspace populated with synthetic conversations. Connect two internal members individually, run the same queries, verify source links and inaccessible-private-content behavior, then demonstrate public-only consent. Present this working flow to Slack for distribution/RTS approval. App creation, credentials, activation and outreach are operational steps, not performed by this code change.

Public release still needs Slack distribution/search eligibility, the accepted in-Slack experience, packaged OAuth handoff verification, rotating member-token concurrency checks, and retention/model-processing decisions. OpenWork currently retains normal chat history and Workflow results; this change adds no Slack archive and makes no zero-retention claim.

Primary sources: [RTS eligibility and scopes](https://docs.slack.dev/apis/web-api/real-time-search-api/), [OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [App Home](https://docs.slack.dev/surfaces/app-home/), [signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/). See also [ADR 0002](adr/0002-cloud-slack-before-distribution-approval.md).
