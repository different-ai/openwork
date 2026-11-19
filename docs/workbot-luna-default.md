# Workbot's explicit Luna default

Workbot and its explicit Luna default are generally available on cloud and
self-hosted deployments. An organization without a saved model uses an explicit
GPT-6 Luna model from the configured runner's authorized catalog.
An exact canonical ID or exact display name identifies Luna; ambiguous aliases
are refused rather than choosing a provider arbitrarily. A saved organization
choice always wins, even when unavailable: Workbot never silently replaces it.
Slack and Automations retain their existing default policy.

## Required correction-safety dependency

Integrate [PR #6147](https://github.com/different-ai/openwork/pull/6147), latest
source head `512539d555c309709fa930aaebeb5b2f5b23065b`, **before the Luna default
rollout**. That head has the same source tree as its functional source head
`fc5f230f3ecf8febfab625bd5fb7ae6b7e8eb63a`; its extra commit only refreshed CI.
The dependency is logical: this branch carries all six unchanged source
patches/authorship replayed onto dev
`f02e4590c78cb52d4c5badefbe48da2d55390dbd`, including merged adoption telemetry
(#6156), Sharing (#6168) and team-settings links (#6165), without copying an
empty CI trigger. The rebased dependency prefix ends at
`686358510decc01a68cd6438aa876616eefca696`; original dependency SHAs are source
references, not literal ancestors of this refreshed branch. No competing
correction implementation or changes to its pending or context work were
introduced; merged Sharing and TeamControls UI is retained alongside it. Corrections append
instead of deleting earlier turns. An earlier successful catalog check is not a safety boundary: the next
lookup inside `modelFor` can fail. Append-only corrections keep the original
history and failed correction recoverable even in that race. There is no
second delete-preflight workaround.

## Readiness and recovery

Den's existing Manage → Workbot page shows **Default: GPT-6 Luna** and a compact
availability row. **Check availability** reads the runner catalog. The runner
marks a catalog verified only after its configured gateway accepts its model
key. Its configured fallback alone, an older runner, a missing key, or a failed
read cannot establish readiness. An empty authorized catalog never verifies
the legacy configured fallback (which remains listed for old clients).
The runner caches a successful gateway catalog for at most five minutes; Den
caches turn reads for one minute and bypasses its cache for an admin check.

Catalog availability is an authenticated model-access check, not a completion,
quota, balance, or provider-uptime guarantee. `/health` remains liveness. The
separate **Test default model** action reports **Answered** only after the
configured runner model adapter (Anthropic, OpenAI Chat Completions or OpenAI
Responses) returns a nonempty completion without tool calls. Merely listing a model never sets that result. A listed model can still
fail with access refused, payment required, unavailable or timed-out states.

The action sends only a server-owned synthetic prompt, without member content,
runner instructions, tools, MCP credentials, files, memory or a conversation.
It uses the existing runner service token and configured model key, resolves
the saved organization default on the server, and accepts only an empty browser
request. Node and Worker hosts use the same probe; Workers do not create or
enter a conversation cell. No chat or answer text is persisted; the completion
indicator stays local to the page. Only status, an allowlisted error code and
requested/provider-reported model IDs are returned; raw provider errors,
answer text and credentials are discarded. A reported ID containing the model
key, or contained within that key (including all-but-one-character fragments),
is omitted; an actual nonempty reply can still report Answered with no unsafe
provider identifier. The IDs are available under the inline Test details
disclosure. Responses checks use the actual stateless adapter with `store: false`;
normal transcript, tool and continuation compatibility remains upstream code.

The completion has an eight-second deadline, a 32-output-token request cap,
and a 16 KiB response cap. The existing adapter may make at most three bounded
attempts within that deadline. One diagnostic runs at a time per runner
process/isolate. This is a small paid request, not a free ping or a monetary
budget guarantee. It never runs automatically at startup, on page load, or on
catalog refresh.

`POST /v1/org/workbot-settings/test-default-model` requires both feature flags,
a genuine user session and sensitive `inference.manage` (including the existing
two-hour recent-sign-in check). API keys and synthesized MCP sessions cannot
satisfy the genuine-user-session guard; the route is also excluded from MCP.
The UI reuses Den's real reauthentication flow. Before inference, existing
`checkRateLimit` / `RateLimitTable` durably allow at most three diagnostic actions
per organization and three per member in a ten-minute inactivity-reset window,
across replicas and process restarts. Rejected authentication, feature checks
and untrusted bodies cannot start a probe. The next action after the limit is
HTTP 429; this diagnostic-only throttle is not a new chat usage budget.

Do not claim a production deployment is ready from a localhost fixture or a
green health response. No live provider was contacted to verify this change.

Before starting a new answer, Workbot checks the actual runner's verified
catalog for the explicit model. When it cannot verify that model, it does not
send on a different model. The failure asks the person to have their workspace
admin check the model. Corrections use #6147's append-only path, so a lookup
failure cannot remove the original or later turns. History reads, files,
active turns and stored model choices are not removed by graduation. There is
no rollout switch for the Luna default; administrators can choose another
available model without clearing history or restarting conversations. Workbot's
existing Den-session cache can delay a changed model by up to 30 seconds.
Existing accepted turns retain their
runner-stored model, including when resumed after interruption.

## Deployment owner confirmation before Monday

Graduation does not configure a live provider or certify a deployment. The deployment owner must
confirm these names on the intended deployment, privately, without copying
values or credentials into a PR, log, screenshot, or chat:

- Runner model route and its Luna binding: `HEADLESS_MODEL_PROTOCOL`,
  `HEADLESS_MODEL_BASE_URL`, `HEADLESS_MODEL`, `HEADLESS_MODEL_API_KEY`.
- Runner service authentication and Den's connection: `HEADLESS_API_TOKEN`,
  `DEN_HEADLESS_RUNNER_URL`, `DEN_HEADLESS_RUNNER_TOKEN`.
- Workbot's runner connection: `WORKBOT_RUNNER_URL`, `WORKBOT_RUNNER_TOKEN`.
- Workbot's Den connection: `WORKBOT_DEN_API_URL`.
- Existing cost-exposure controls to review, not change here:
  `HEADLESS_MAX_CONCURRENT_TURNS`, `HEADLESS_MAX_STEPS`,
  `HEADLESS_MAX_OUTPUT_TOKENS`, `HEADLESS_TURN_TIMEOUT_MS`.

Confirm that Den and Workbot point at the same intended runner and that its
authorized alias really maps to Luna. Confirm the runner default as well:
conversation naming uses that configured model independently of answer routing.
Then the owner can check the actual admin catalog state and explicitly choose
Test default model for the intended rollout organization before expanding it. A missing
or ambiguous Luna alias must remain unavailable; do not substitute a provider
or turn on the feature to conceal a readiness failure.

## Shared-key usage risk — budget system deferred

The current runner uses one deployment model key unless a caller supplies its
own. Its MCP token scopes connected-app access; that token is not a per-member
inference credential or a spend allowance.

**Organization admins can select any key-authorized catalog model**, including
new workspace owners who already hold `inference.manage`. A Luna default does
not restrict that choice and is not a spend cap. Before enabling Workbot
globally, the deployment owner must scope the runner key's catalog/permissions
to the intended GA models and confirm provider-side spend limits and alerts.
These are owner/provider controls, not a new OpenWork billing guarantee.

Existing protections are not durable monetary budgets:

- Workbot's 30-message/10-minute/member throttle lives in a process-local Map;
  restarting or scaling the app does not preserve a single shared allowance.
- Den's 120 run-token throttle is **already database-backed**, keyed by
  organization and user (`checkRateLimit` / `RateLimitTable`). It survives app
  process restarts. It limits token minting, not inference tokens or dollars.
- Runner concurrency defaults to 32. Step count is unbounded by default and
  output length is bounded per model call, not per member or billing period.
  Greetings, retries, resumed turns, background tasks and conversation naming
  can consume inference beyond one visible send.

The Gateway's existing paid usage limits require an authenticated organization
and member scope plus admission snapshots and idempotent settlement. Free
member allowances require the member's active inference key, joined membership
and free-policy checks; they are a distinct entitlement, not a general budget
for the runner's shared credential. Neither can safely be charged to a member
by adding an untrusted header or by counting Workbot sends. Reusing them here
would need trusted delegation for every model call, including helper work,
and defined accounting on crashes, retries, missing usage and concurrent work.
That is not a small safe routing change, so this change adds no billing system
and claims no durable per-member spend protection.

Options for the owner:

1. Workbot no longer has a rollout switch. Before exposing the configured runner,
   explicitly accept shared-key exposure and confirm actual provider-side caps,
   alerting and operating limits. Restrict runner/service access if that exposure
   is unacceptable. Changing the default model does not cap spend. These controls
   are deployment-wide, not member fairness or a hard monetary guarantee.
2. Follow up with member-scoped Gateway delegation and reuse its existing
   usage-limit admission/settlement primitives at each inference request.
   Define what greetings and helper work debit and how concurrent overshoot is
   bounded. Treat unknown accounting as blocked, not free usage.
3. If only abuse throttling is required, separately reuse Den's durable rate
   limit primitive for member turn admission across replicas. Name it a request
   throttle, not a monetary or token budget; it does not address unlimited steps.

No new schema, migration, live-provider call, credential lookup or production
data is needed for implementation or its deterministic localhost-provider tests.
