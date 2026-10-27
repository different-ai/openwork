# Live provider sync (OpenCode v2)

`liveProviderSync` is one registry rollout, default **off**, available on cloud
and self-hosted deployments. It is not a second desktop preference or an
independent environment switch. Den resolves the registry for the signed-in
member's organization; an absent feature is off.

## Ownership

With the rollout enabled, the bundled OpenWork provider plugin owns the v2
AI Gateway catalog. It fetches the same member-visible inventory used by the
standalone `opencode-openwork` plugin and injects it through
`ctx.provider.transform`, not generated provider configuration. A changed
snapshot invokes `ctx.provider.reload()`. The pinned engine's
`provider.updated` / `model.updated` events invalidate the app's existing
provider-list query, including an already-open model picker. The adapter also
accepts `catalog.updated` for compatibility; that is **not** the event emitted
by OpenCode 2.0.26.

Den's SSE stream is an invalidation channel, not a second copy of inventory.
It sends `inventory.changed` with a content revision on connection and when
the member's effective inventory changes. The plugin refetches on every
invalidation and reconnect; an unchanged snapshot does not reload the engine.
A disconnected client can therefore recover without replay or a pub/sub
service. Heartbeats and a bounded reconnect loop detect broken streams.

### Revision dependency check

The revision is a member/org-scoped HMAC over the caller-visible projection
of batched persisted dependencies in a repeatable-read, read-only transaction.
Live team memberships and grants resolve effective access first; only granted
providers, allowed models and links, visible groups/credential sets, relevant
organization/member credentials, and the caller's gateway keys are hashed.
Unrelated grants, other members' credentials, inaccessible models/providers,
and incidental provider touch timestamps cannot change this member's revision.
Credential expiry and AWS client expiry add readiness booleans, not the wall
clock, so time-only loss of readiness also invalidates inventory. The stream
rechecks the current auth session, membership and uncached registry rollout on
every read. Only the opaque revision leaves Den.

This deliberately favors complete dependency coverage over `MAX(updated_at)`
or a stored provider counter: those miss indirect grant/team writes, deletions,
key rotations and config-only changes. It avoids per-provider summary/connect
calls, upstream requests and gateway-key issuance during revision checks.
Organization-indexed batches avoid rebuilding every provider's member summary,
but still scale with the organization's stored access data. This is not a
claim of constant-time revision checking. Scoping the projection is also an
isolation requirement: an opaque revision must not signal activity on
inaccessible resources.

The old server materialization/push/confirm and app refresh triggers remain
in place for the flag-off path and OpenCode v1. Local/legacy providers keep
their existing path; MCP synchronization is independent of this rollout.
The desktop reads the same `/v1/me/desktop-config` surface as organization
default models, then uses the server's effective v2 ownership status rather
than independently flipping the app when a cached rollout value changes.
On signed-in cold boot, late session hydration can activate the live source
through one watched-config rewrite that simultaneously removes old gateway
rows and registers the bundled plugin. This activation is one-way for that
engine lifetime.

## Credentials and account boundaries

Desktop uses its existing Den session, not a second device login. That bearer
stays inside the OpenWork server: project-loaded plugins share the engine
process, so putting it anywhere in that process is not a sufficient boundary.
A private loopback bridge exposes only identity metadata, scoped inventory
reads/streams and authorized model inference. Long-lived Gateway credentials
also stay server-side. The engine uses an identity-bound, per-engine ephemeral
loopback credential, not a reusable Gateway key. The transport capability is
delivered over a one-shot anonymous pipe. Neither the initial process environment nor a config file,
argument, URL or named socket contains that capability. A trusted inert
consumer loads even on flag-off boot and closes the descriptor before native
tools can run; it makes no Den/session requests until live ownership starts.
This permits late sign-in without exposing an unread pipe to tool subprocesses.

OpenCode isolates ESM graphs across Locations. A credential-free CJS broker
loaded through a canonical native `createRequire` filename shares one frozen
request API through the process-wide native module cache. Its private closure
owns the scoped inventory capability, bound to one bridge endpoint. Broker
code on disk contains no credential, and there is no global credential getter.
The transport does not expose the Den bearer or reusable Gateway key, even
to another engine plugin. It permits only inventory and authorized inference
routes, not administration, MCP or provider mutations. It binds requests to
the current identity; session replacement fences pending reads and streams. This is necessary:
independent ESM closures would leave later workspaces permanently empty after
the first graph consumed the pipe. The bridge returns no session until live
ownership is selected. No Den session token is written into `opencode.json`,
plugin options, a URL, or a command line. A loopback listener without
authentication is not an acceptable substitute.

The desktop cache contains account/org-scoped catalog metadata, not reusable
Gateway credentials. Cached definitions are rebound to the current engine's
loopback route and ephemeral credential before publication, including warm
startup; old bridge ports/credentials cannot survive in the active provider
settings. Standalone users retain their explicit device-login behavior.
Session replacement cancels the old stream and fences pending fetches so one
identity cannot publish after another signs in. Den authorization continues
on inference requests: a cached catalog is not offline authorization.

## Timing and limits

The target is roughly two seconds from a committed Den inventory change to
picker invalidation on a healthy local connection. The server checks every
two seconds, so this is an eventual-consistency target, not a strict
2,000 ms upper bound: database work, inventory requests, engine reload and
rendering add latency. Disconnected clients retain their last usable
snapshot until reconnection; they cannot truthfully promise zero staleness.
The important invariant is one active catalog owner and convergence after
every invalidation or reconnect, not an impossible guarantee of instantaneous
consistency during a network partition.

## Model loss in a conversation

An engine catalog is an availability snapshot, not evidence that an organization
removed a model. A managed selection stays pending during an incomplete catalog,
failed inventory read, or member sign-in requirement. Before replacing it, the
app requires two complete, independently fetched member inventories from Den,
separated by the reload grace period and a fresh engine catalog read. Gateway
inventory must report `modelAssignmentsComplete: true` for every returned
provider; an older Den or a credential-related omission cannot authorize
replacement. The marker checks every effective active group/set grant, not the
provider's aggregate credential status. Den still authorizes
every inference request.

An explicit `ModelUnavailable` / `ProviderModelNotFound` send rejection refreshes
the workspace catalog and retries once with the same request/message identity.
Transport failures and unknown admission never replay. A second rejection stays
inline through the existing send-error path.

`modelRemovalRecovery` (cloud and self-hosted, default off) changes confirmed
removal recovery: prefer a usable model from the same maker/family, then personal
pins, recent choices, and picker order. Only that conversation changes. A quiet,
dismissible composer note offers Change and, after the old model returns,
Switch back. Display names are remembered in bounded account/workspace-scoped
local storage; this cache never grants access. Without another usable model the
composer picker/empty state offers the next action. Turning the rollout off
hides the note and restores legacy confirmed-removal presentation, without
undoing a selection, interrupting work, or weakening authoritative confirmation.

## Kill switch

The registry kill switch rejects new stream connections and causes active
streams to end on their next authorization/feature check. It does not cancel
an in-flight model request or delete chat history. The engine's selected
catalog owner must remain consistent for its lifetime: do not enable the old
writer alongside a still-loaded live plugin. At minimum, the next engine
start resolves the rollout again from fresh desktop-config hydration and
restores the complete legacy path when off. If Den cannot be verified, this
feature defaults off for the new engine while existing offline model-access
and permission policies are retained. A running engine may retain its last
snapshot until that restart;
revoked gateway access is still rejected by Den. Restart the engine to finish
a rollback immediately.

## Premise review

Reviewed against OpenCode `v2.0.26`, upstream commit
`9b4ec5714d481559990db0a816d5dec19541a814`:

1. **Reload notification — adapted.** `ctx.provider.reload()` forwards to the
   provider state reload. It publishes `provider.updated`, which also
   invalidates model state and publishes `model.updated`. The server event
   feed serializes these names unchanged. The desktop previously listened
   only for `catalog.updated`; that assumption does not hold at this pin.
2. **Composition — qualified.** Provider reload rebuilds all source transforms,
   then model transforms inspect the complete active provider inventory. The
   bundled final `ConfigPolicy` can remove providers. But the bundled
   `ConfigProvider` model transform runs after external model filters and can
   recreate explicitly configured models. Keeping live-owned providers out of
   generated config is a correctness and policy requirement, not an
   optimization. Preserve filter rules independently of mirrored models.
3. **Credential hand-off — narrowed after review.** The standalone plugin
   expects its own OpenCode OAuth connection. Desktop retains the Den bearer
   in the OpenWork server and gives the engine only a scoped inventory
   transport capability plus stable opaque identity metadata. Neither the
   Den bearer nor the OpenWork host token enters the engine process. The
   bridge forwards authorized reads/streams without owning provider state,
   caching inventory or polling Den. Desktop does not enable the standalone
   plugin's sign-in or MCP integration.

Upstream source: [provider state](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/provider.ts),
[model state](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/model.ts),
[config providers](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/config/plugin/provider.ts),
[policy](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/config/plugin/policy.ts).

## Verification

- `ee/apps/den-api/test/provider-inventory.test.ts`: dependency revisions,
  time-only readiness, SSE framing, heartbeats, cancellation and authorization
  failure.
- `packages/opencode-plugin/src/*.test.ts`: subscriptions shared by Locations,
  reconnects, retry convergence, idempotency and account/authentication fences;
  standalone sign-in and MCP regression coverage.
- `apps/server/test/live-provider-sync.test.ts`: on/off ownership, legacy
  polling isolation, generated-config filtering and the credential boundary.
- `apps/server/test/live-provider-sync-native.test.ts`: actual bundled plugin
  and filters on pinned v2, native events, unchanged config, reconnects,
  revocation, account replacement and sign-out. Run on both Bun and desktop
  Electron Node; absent engine binaries explicitly skip.
- `apps/app/tests/live-provider-sync*.test.ts` and
  `provider-catalog-live-events.test.ts`: effective-owner gating, session
  delivery and event invalidation without changing the flag-off path.
- `evals/proofs/live-provider-sync.proof.test.ts`: real Den administrator
  model enable/disable writes reaching the already-open v2 model picker,
  without navigation or periodic provider sync, with a five-second deadline.

## Compatibility

The standalone npm plugin retains its own device-login integration. The
desktop entry only supplies provider inventory; it must not duplicate desktop
MCP registration or add a second account selector. Provider/model transforms
compose with the bundled model policy filters, so live injection must not
bypass disabled providers, allowlists or denylists.
