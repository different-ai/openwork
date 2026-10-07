# ENG-76 native Slack validation — operational draft

**Historical draft, superseded 2026-09-30. Do not apply this configuration.** The current hosted multi-workspace setup is [Slack Cloud setup](slack-cloud-setup.md). Organization/workspace-ID and global bot-token environment settings below have been removed from the implementation. As of 2026-10-06, the old Slack enablement environment variable below is also retired: use the registered **Slack search** feature in `/admin`, with per-organization overrides, the everyone default, and the shared kill switch. The remaining text is a historical record, not current setup instructions.

**Disabled. No live activation is authorized by this document.** Implementation approval covers code and synthetic tests, not Slack app creation, installation, distribution, fixture provisioning, credential changes, flag enablement, outreach, or real Slack API calls. No live app settings or token grants were inspected. Primary setup documentation was retrieved on **2026-09-28**.

The [approved scope](eng-76-native-slack-connect.md), [rollout ADR](adr/0001-internal-first-native-slack-rollout.md), and [provider research](research/eng-76-slack-web-api-feasibility.md) remain controlling. This is a preparation checklist, not Marketplace approval, provider eligibility confirmation, or legal clearance.

## Boundary and activation prerequisites

- Limit availability to the designated OpenWork internal organization **and** its approved, OpenWork-owned Slack validation workspace. Use only synthetic conversations and internal test members; keep identities and credentials out of this public repo.
- `DEN_SLACK_ENABLED` defaults to false. Organization administrators cannot bypass this deployment gate. The general Connect switch is not sufficient authorization to enable native Slack.
- Confirm Slack's internal-app/Real-time Search (RTS) eligibility and the acceptable minimum in-Slack experience before activation. Modern RTS excludes unlisted distributed apps. A working HTTP response or a static Home tab does not establish provider approval. [1]
- **App Home token setup remains an activation blocker:** the method reference says `views.publish` needs no scopes, but the current App Home guide requires at least one **bot token scope** to enable Home and uses a bot token to publish. `app_home_opened` requires a configured, installed bot user. The reviewed docs do not establish a zero-bot-scope Home installation for this new app. [4, 5, 7, 12]
- Do not add `chat:write`, bot history/search permissions, the legacy `bot` scope, or an unrelated permission solely to obtain a bot token. This draft deliberately does not select a bot scope. Establish a valid least-privilege setup consistent with the approved help-only surface before configuring `DEN_SLACK_BOT_TOKEN`; if that requires expanding scope, obtain a separate product/security decision.
- Validate rotating-token behavior at the intended deployment concurrency before activation. Credential persistence uses identity checks and compare-and-set, not cross-instance serialization of provider refresh requests; provider grace-period and active-token limits need a dedicated live concurrency check.
- Obtain separate authorization before creating/configuring/installing the app, storing credentials, creating live synthetic fixtures, or enabling the gate. Keep external installations and ordinary internal real-data use disabled. Terms, distribution authorization, retention, model-provider processing, and mixed-origin Slack Connect data remain separate gates. [1, 11]

The existing external Slack MCP/BYO-app connections, credentials, setup, and eligibility warnings are untouched. Their existence does not authorize this native connector or external rollout.

## Confidential member OAuth

After the prerequisites and separate operational approval, the intended setup is an OpenWork-supplied, granular-permission app associated only with the owned validation workspace. Members authorize their own Slack identities through hosted OpenWork Connect; they do not create an app or supply developer credentials. Slack administrator approval and member consent may still be required.

Use the standard confidential flow, not Sign in with Slack or a desktop-held client secret: [2, 10]

- Authorize at `https://slack.com/oauth/v2/authorize`, with member permissions in **`user_scope`**. Bot scopes, if separately resolved and approved for Home, are a different grant, not the member lookup credential.
- Register the exact HTTPS Den API callback **`/v1/oauth-providers/slack/connect/callback`**. Use the deployment's configured public API origin, not the frontend origin or the external MCP callback. The same redirect URI must be used during authorization and exchange.
- Exchange the temporary code on the server at `https://slack.com/api/oauth.v2.access`, with server-held client credentials and validated state. Member access tokens and actual granted scopes come from **`authed_user`**, not the top-level bot token.
- Validate the returned workspace against the deployment gate. An OAuth `team` hint is not an authorization boundary. Each OpenWork member uses their own token; the first release supports one connected Slack workspace per member.

### Required and explicitly optional user scopes

| Category | Search | Thread/history read | Consent |
| --- | --- | --- | --- |
| Public channels | `search:read.public` | `channels:history` | Required |
| Private channels | `search:read.private` | `groups:history` | Both explicitly optional |
| One-to-one DMs | `search:read.im` | `im:history` | Both explicitly optional |
| Group DMs | `search:read.mpim` | `mpim:history` | Both explicitly optional |

Declaring capabilities “optional” in prose is insufficient: put all six optional scopes in **both** `oauth_config.scopes.user` and `oauth_config.scopes.user_optional`. Slack documents that optional permissions can be declined without blocking the entire installation; actual grants control which categories can be queried. Public-only access is usable limited access, not evidence that private/DM searches found nothing. [1–3]

This **non-importable configuration fragment** records the member scope contract. The example origin is synthetic and must not be used for a live app. It is not a complete or provider-validated app manifest; Home's bot grant is intentionally unresolved.

```yaml
oauth_config:
  redirect_urls:
    - https://api.example.test/v1/oauth-providers/slack/connect/callback
  scopes:
    user:
      - search:read.public
      - channels:history
      - search:read.private
      - groups:history
      - search:read.im
      - im:history
      - search:read.mpim
      - mpim:history
    user_optional:
      - search:read.private
      - groups:history
      - search:read.im
      - im:history
      - search:read.mpim
      - mpim:history
```

No legacy `search:read`/`search.messages` fallback, file scopes, message writes, reactions, background sync, or bulk history import. Optional private/DM search also depends on Slack's administrator/member consent rules. Do not reuse broader old grants: Slack documents additive scopes, so changing a request is not proof that previously granted permissions were removed. [1, 2]

## Conditional Slack Home/help setup

**Do not apply these settings now.** Once bot-token setup, provider requirements, and operational activation are separately cleared, the intended manifest/settings contract is: [3–8]

| Setting | Intended value |
| --- | --- |
| `features.app_home.home_tab_enabled` | Enabled only after the unresolved Home prerequisites are met |
| `features.app_home.messages_tab_enabled` | Disabled |
| `features.bot_user` | Configured/installed only with the separately verified least-privilege bot grant; not a chatbot |
| `settings.event_subscriptions.request_url` | HTTPS Den API origin + `/v1/slack/events` |
| `settings.event_subscriptions.bot_events` | Only `app_home_opened` |
| `settings.event_subscriptions.user_events` | Empty/omitted; no user-level message events |
| `settings.interactivity.is_enabled` | Disabled; the view uses an ordinary text link, not interactive buttons |
| `settings.org_deploy_enabled` / `settings.socket_mode_enabled` | Disabled |

No message subscriptions, shortcuts, slash commands, agent/assistant messaging view, incoming webhooks, or `chat.postMessage` implementation are included. Do not copy the broader permissions/events from Slack's example manifest.

The public endpoint supports signed URL verification and `app_home_opened` with `tab: home` only. Slack's documented verification payload has no workspace ID; it is authenticated by the app signing secret and deployment gate. Any supplied verification workspace must match. Home events always require the approved workspace. Before each publication, the server calls `auth.test` with the configured Home bot token and requires a bot identity in that same approved workspace; a token for another workspace cannot publish. No member connection status is inferred from this bot token. [5, 8, 9]

The static Block Kit view states **Internal validation. Synthetic conversations only**, read access limited to authorized conversations, no posting/replies, and **Account connection not verified here**. Its single link is **Manage connections**, using the existing member frontend route `/dashboard/your-connections` at `env.betterAuthUrl`. It does not deep-link with a token or assert the visitor has a connected Slack account.

Design rationale: compact state hierarchy and one action (DESIGN **P1, P2, P6, P7, S4, C1, C3**). Slack Block Kit is the required native primitive, rather than web components (**P5**). Synthetic HTTP assertions verify the payload, **not** Slack rendering. Real-size visual evidence remains outstanding under **P10** and is not authorized by this draft.

## Server configuration contract — names only

| Key | Purpose |
| --- | --- |
| `DEN_SLACK_ENABLED` | Default-off deployment gate; not distribution permission |
| `DEN_SLACK_ORGANIZATION_ID` | Designated internal OpenWork organization |
| `DEN_SLACK_WORKSPACE_ID` | Approved synthetic Slack validation workspace |
| `DEN_SLACK_CLIENT_ID` / `DEN_SLACK_CLIENT_SECRET` | Confidential member OAuth app credentials |
| `DEN_SLACK_SIGNING_SECRET` | Optional until approved Home setup; verifies Slack Events requests |
| `DEN_SLACK_BOT_TOKEN` | Optional until least-privilege Home setup is established; Home only, never member searches |
| `DEN_SLACK_API_BASE_URL` | Official default `https://slack.com/api`; development-only synthetic fixture override, leave unset for live use |
| `DEN_SLACK_OAUTH_AUTHORIZE_URL` / `DEN_SLACK_OAUTH_TOKEN_URL` | Development-only synthetic fixture overrides; leave unset for live use |

All secrets and provider tokens stay server-side, outside desktop bundles, browser JavaScript, URLs, logs, public fixtures, and screenshots. The OAuth client secret, Slack signing secret, and bot token have distinct purposes and are not interchangeable. Member lookup tokens are stored through the existing encrypted connected-account path. This task does not create or change credentials. [2, 7, 10]

### Route registration and safety contract

The Den app registers `registerSlackAppHomeRoutes(app, signedWebhookRoute)` from `ee/apps/den-api/src/routes/slack-app-home.ts`, passing the existing `signedWebhookRoute` marker from `middleware/index.ts`. The marker is pass-through; the handler performs the full signature verification. Passing it from the app keeps this standalone webhook independent of the marker module's member-auth/database imports. The route authenticates with Slack request signatures, not OpenWork member sessions. Preserve the original raw body; do not put a JSON-rewriting middleware in front of it. Do not add agent capability discovery/execution metadata for this endpoint.

- Version `v0` HMAC-SHA256 over the timestamp and raw bytes, constant-time digest comparison, and a five-minute timestamp freshness window. Never use the deprecated verification token. [8]
- One two-second deadline across request-body reception, `auth.test`, and `views.publish`, below Slack's three-second acknowledgement window. Maximum 32 KiB incoming body and 64 KiB per provider response. No redirects or automatic outbound retries. [6, 8]
- At most four concurrent publications and 256 remembered delivery IDs per process, expiring when their signed timestamp is no longer fresh. Duplicates are acknowledged without republishing; capacity overflow is refused, not queued. Only event IDs and expiry times are kept, not event content. This is bounded best-effort deduplication, not cross-replica/exactly-once delivery.
- A non-success response includes `X-Slack-No-Retry: 1`. If publication times out, Slack may already have applied the static view; no automatic repeat is attempted. A later Home visit can produce a new event. There is no durable work queue. [6]
- Recheck the deployment organization after reading the body and recheck organization/workspace after `auth.test`, immediately before publication. There is no organization-admin override.
- Errors contain stable classifications only. No raw request payloads, provider error bodies, credentials, or conversation content are logged by the route.

Disabling the gate stops new Home publications as well as gated native connection/capability paths. It does **not** remove a previously published Slack Home view or erase existing OpenWork transcripts/Workflow snapshots. The view intentionally makes no live connected-account claim. Normal OpenWork session persistence is accepted only for synthetic validation; it is not a zero-retention promise or real-data approval.

## Verification performed and still needed

The isolated Node test file `ee/apps/den-api/test/slack-app-home.test.ts` exercises the public signed HTTP seam against a loopback synthetic `auth.test`/`views.publish` server. No live Slack authentication or app configuration is involved. Run one file only:

```sh
pnpm --filter @openwork-ee/den-api exec tsx --conditions=development --test test/slack-app-home.test.ts
```

This does not prove token issuance, actual optional-consent screens, Slack rendering, or RTS eligibility. Before a separately approved synthetic live acceptance, resolve the Home bot-token prerequisite, verify the provider's in-Slack-experience requirement, approve the designated organization/workspace and two internal members, and complete the agreed member-isolation and partial-consent journey. External rollout, ordinary real-data use, and Marketplace work remain outside this activation.

## Primary setup sources

All retrieved on 2026-09-28; read with the linked feasibility research rather than treating method existence as permission.

1. [Using the Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/) — eligibility, user scopes/consent, outside-Slack use, in-Slack experience, and data-use guidance.
2. [Installing via OAuth authorization code flow](https://docs.slack.dev/authentication/installing-with-oauth/) — standard confidential flow, `user_scope`, `authed_user`, optional scopes, and additive grants.
3. [App manifest reference](https://docs.slack.dev/reference/app-manifest/) — `user_optional`, App Home, bot user, and event subscription fields.
4. [App Home](https://docs.slack.dev/surfaces/app-home/) — bot-scope enablement prerequisite, bot token publication, and disabling Messages.
5. [`app_home_opened`](https://docs.slack.dev/reference/events/app_home_opened/) — no event-specific scopes, but a configured and installed bot user is required.
6. [Events API](https://docs.slack.dev/apis/events-api/) — three-second acknowledgement, retries, `X-Slack-No-Retry`, and event envelope.
7. [Tokens](https://docs.slack.dev/authentication/tokens/) — bot versus member tokens; app-level/configuration tokens are not substitutes for Home publication.
8. [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/) — raw-body HMAC, freshness, and timing-safe comparison.
9. [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) — no added scopes; workspace identity and bot response fields.
10. [Security best practices](https://docs.slack.dev/concepts/security/) — server-held secrets, least privilege, and token-owner isolation.
11. [Slack API Terms](https://slack.com/terms-of-service/api) and [Developer Policy](https://docs.slack.dev/developer-policy/) — independent distribution and data-use obligations.
12. [`views.publish`](https://docs.slack.dev/reference/methods/views.publish/) — authenticated static Home publication, no method-specific scopes. This does not negate the Home setup prerequisite in source 4.
