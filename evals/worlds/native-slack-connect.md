# ENG-76 synthetic native Slack journey

Spec: `evals/specs/native-slack-connect.e2e.test.ts`.

This is browser-representable desktop product proof (`seed.appWeb`) plus the
real Den `/admin` UI. It is not packaged-desktop, real Slack, provider eligibility,
app-distribution, or live-activation proof.

## Boundaries

- Real: app-web, managed OpenWork server/engine, Den-web admin controls, Den
  authorization, shared feature resolution, native discovery, OAuth state/callback,
  credential storage, capability dispatch and scope enforcement.
- Synthetic: a loopback Slack OAuth/Web API server and a deterministic model.
  The model discovers real capability names, derives thread IDs from native
  results, and renders only content/links/limits present in tool results.
- Fixtures: two Slack identities, four conversation categories, a private-message
  canary, a 105-message thread served in a two-message page, and another Slack
  workspace with distinct conversations. No outside identities or data.
- No custom integration, OAuth client, connector, Slack Assistant installation,
  shared read token, account row, or provider approval is injected. Each Cloud
  member mints their own audience-valid gateway token with exactly `mcp:read`.
  Slack user tokens are obtained only through browser consent and callback.
- Den's isolated child rejects fetches to `slack.com` and subdomains. App browser
  profiles block those hosts too; synthetic source links are inspected, not opened.

## Setup contract

The world calls `seed.den` **once**, with Den-web enabled and a testkit-owned
`openwork_eval_*` database. The process is explicitly configured with:

- `DEN_DEPLOYMENT=cloud`
- `DEN_ORG_MODE=multi_org`
- `DEN_SLACK_CLIENT_ID=eng-76-synthetic-client`
- `DEN_SLACK_CLIENT_SECRET=eng-76-synthetic-secret-not-a-credential`
- `DEN_SLACK_API_BASE_URL=<owned loopback origin>/api`
- `DEN_SLACK_OAUTH_AUTHORIZE_URL=<owned loopback origin>/oauth/v2/authorize`
- `DEN_SLACK_OAUTH_TOKEN_URL=<owned loopback origin>/api/oauth.v2.access`

All values are synthetic and process-scoped. Inherited shared-feature operator
locks are cleared, as is the Slack signing secret. There is no bespoke rollout
flag, second gate-off process, database feature write, or seeded Slack override.
The registry starts `nativeSlack` off; Connect retains its existing default.
Workspace/member identity is discovered through OAuth and `auth.test`, not env.

`seed.den` makes only its `den.admin` platform-allowlisted. Two members belong to
organization A. A separate ordinary account creates and owns organization B;
its owner role is witnessed over HTTP and its platform feature writes must fail.
The admin, B's owner, and A's first member each have a signed-in Den-web profile;
the two A members also have independent app-web/engine profiles.

App-web uses the existing headless development proxy:
`OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=1`, a logical web target, and
`OPENWORK_DEV_HEADLESS_DEN_API_TARGET=den.ref.apiUrl`.
`VITE_DEN_BASE_URL=den.ref.webUrl`, `VITE_DEN_API_BASE_URL=/api/den`.
The world now serves Den-web for the admin/member management surfaces. Ordinary
app browser requests remain same-origin; production CORS is unchanged.

Native API search is GET `/v1/capabilities/slack/search`; MCP invokes its
**discovered** name with `query`, not `body`. Optional `conversationTypes` is
comma-separated. Upstream RTS remains POST; threads remain GET.

## Proof sequence

Every step records one assertion-evidence line. Screenshots explain the named
step but never supply a pass verdict.

1. Both independently pinned engines are healthy. Configured OAuth credentials
   alone leave A and B without Slack discovery, Connect or usable native routes.
2. B's ordinary owner cannot write organization or everyone feature settings.
3. The platform admin opens `/admin` → Organizations → A → Features and checks
   **Slack search**. A gets Connect; B remains absent and generates no provider
   calls. Slack Assistant/headless remain off.
4. Turning **OpenWork Connect** off still blocks A despite its true Slack
   override. Restoring Connect restores the consent entry, not an account.
5. Preserve the member-owned OAuth, read-only MCP, four conversation categories,
   bounded/incomplete thread, second Slack workspace, private membership and
   limited-consent assertions from the existing journey.
6. The admin separately enables B through the same organization UI. Slack
   Assistant stays off and B's owner cannot save custom Slack app credentials.
   Its missing grant still yields `needs_connection`; browser consent then
   searches B's own workspace without sharing A's account.
7. The admin unchecks A. Subsequent start/status/search/thread requests and
   retained MCP execution are denied without provider calls, while B still
   searches. A's stored identity remains blocked by OpenWork and not in need of
   reconnection; the member sees Disconnect rather than Connect/Reconnect.
8. Everyone=On does not override A's explicit false. **Use everyone's setting**
   stores null, allowing A to inherit On and reuse its account. Everyone=Off
   disables inheriting A while explicitly enabled B remains usable.
9. Explicitly enable both organizations, then use **Turn off everywhere**.
   `source=killed` overrides both stored true values; both retained accounts stay
   present but unusable. **Restore** resumes both accounts without new OAuth.
10. Disable A again; its member removes their blocked account through Your
    Connections, without affecting B or calling the provider.

All positive feature mutations use the generated UI. Observation helpers only
GET `/v1/admin/organizations/:id/capabilities` and `/v1/admin/features`. Negative
owner writes use the real PUT routes with `{ capabilities: { nativeSlack: true } }`
and `{ enabled: true }`. No `seed` calls occur after the first user action.

## Selectors and helpers

- Organization search waits for exactly one `admin-org-row-<slug>`, then uses
  `admin-capability-nativeSlack`, `admin-capability-source-nativeSlack`, and
  `admin-capability-reset-nativeSlack`. Connect uses the same generated selectors
  with `mcpConnections`; no parallel admin UI was added.
- `/admin/features` uses `admin-feature-nativeSlack`, its state, kill and restore
  test IDs. The existing On/Off radios lack scoped testkit targets: their index
  is derived from the actual rendered feature rows, not a copied registry order.
  The saved HTTP state and visible state line independently verify the target.
- `confirmAdminKill()` is a narrow native-browser-dialog action. In parallel with
  the user's real kill-button click, it accepts the browser's confirmation using
  CDP, with a 10-second bound. Testkit has no native dialog channel. It does not
  replace `window.confirm`, execute page JS, or write feature state via HTTP.
- Your Connections uses existing `connect-my-mcp-account-slack` and
  `disconnect-my-mcp-account-slack` actions. Read-only HTTP witnesses verify the
  saved identity, policy owner and account removal.
- `expectBlocked()` observes both start aliases, OAuth status, native search,
  native thread reads, MCP discovery, and (once discovered) retained execution.
  Native reads/retained execution must specifically report `policy_blocked`;
  a wrong-audience authentication failure is not accepted as rollout evidence.

## Engine preparation

The local app-web stack boots a V1 compatibility primary even when chat is routed
to V2. Supply repository-pinned binaries through `OPENWORK_OPENCODE_BIN` and
`OPENWORK_OPENCODE2_BIN`; a V2 binary on the generic `opencode` PATH cannot satisfy
the V1 launcher. Prepare verified sidecars using the repository's
`prepare:sidecar` script rather than relaxing parsing or changing machine installs.

With `--engine v2`, the journey checks both public runtime statuses against the
build manifest, distinct PIDs, and native message history for the actual UI
conversation. CLI selection alone is not the runtime witness. Set `CHROME_BIN`
to isolated Chrome-for-Testing when system Chrome is absent; the harness owns
its temporary profiles. MySQL/Redis can come from
`packaging/docker/docker-compose.web-local.yml` with loopback-only port overrides.

## Placement and outstanding proof

Run through the normal E2E CLI and retain its placement line; do not force a lane
to make it green. The native-provider fixture owns local loopback sockets.
Testkit has remote `mcpMock` transport, but no equivalent transport co-locating
native OAuth/API, Den, app-web and inference. A non-local or attached-Den run
therefore reports `needs: isolated co-located native Slack HTTP fixture; testkit
has no Daytona native-provider transport`, not a passing simulation.

This child did not run tests, builds, or servers. The parent owns sequential
checks and screenshot/evidence review. Until then, the proof is **Incomplete**.
Real Slack authorization/optional-consent UI, eligibility/plan behavior,
packaged OS handoff, self-hosted/operator-lock deployment matrices, signed static
App Home handling, and live activation remain outside this journey. Feature
checks prove requests made **after** each completed UI save; they do not establish
atomic cancellation of already in-flight calls or mid-callback revocation.
