# Coworker Native Plugins

Native-v2 is integrated into the Coworker feature branch, September 12, 2026.
Main/server/renderer select the native engine while retaining Calendar/Events,
Activity, Abilities and current Computer Use. The legacy server/browser/ORM runtime
edges are removed. Source checks and the local unsigned build pass; packaged
application behavior has since been checked in an isolated unsigned package; signed
distribution remains a separate CI check. See RELEASE-SIZE
for the measured package boundary rather than treating compilation as runtime proof.
Legacy history import is optional separate work, not a fresh-profile prerequisite.
No real user profile or paid provider is used by the checks below.

## Build And Startup APIs

Packaging uses the checked-in `native-source.json` recipe and
`patches/opencode-invocation-filesystem-scope.patch`, not the published beta engine.
`node apps/coworker/scripts/build-native-source.mjs` fetches upstream commit
`8520617ca86ba0acd883f7169324db2b3a3f2a59`, checks the patch SHA-256, applies it
with Git's index checks, and requires the exact patched tree
`8496cfdb3d788c56bdb9b920f687ffad06f5f440`. Bun **1.4.2** must be on PATH.
It installs the immutable source's frozen lockfile, builds schema/plugin/SDK,
and compiles the host target with web UI and source maps excluded. x64 uses the
upstream baseline target; no cross-target package is inferred from the host.

The source/patch/target/toolchain-keyed `.native-source` cache lives under ignored
sidecar staging. Reuse verifies the source tree, lockfile, all 354 SDK output files,
package versions, executable header, byte count, SHA-256 and `--version`. Missing
receipts, changed files or wrong toolchains fail, rather than selecting beta or
another cached binary. Inspect and move aside an incomplete owned cache before
retrying. No native release publication or private source directory is required.

The CLI build patch includes `script/portable-paths.ts`. Bun otherwise folds
CommonJS `__dirname`/`__filename` into absolute host paths in TypeScript,
`@npmcli/run-script`, `@npmcli/arborist`, `write-file-atomic` and photon-node.
The build plugin gives only those five dependency files lexical bindings to
`import.meta.dirname`/`filename`, which resolve to Bun's compiled virtual
filesystem. It does not replace paths with inert strings, relocate the build to
a disguised directory, or alter the privacy gate. Photon retains its existing
embedded WASM path. The compile regression extracts this helper from the pinned
patch, proves the old compile retains paths, and verifies the corrected compile's
virtual locations and embedded-file read after removing its source directory.

`build:electron` builds the shared prerequisites before loading the plugin helper,
then bundles all nine plugins against that source SDK, including compatibility
for the older `@opencode-ai` import namespace. Production identity is
`0.0.0-local-coworker-8520617-249c350a376d`, a stable source-build version accepted
by the explicit `native-2` profile, not a registry release. The build receipt records
the actual target's executable and SDK hashes; unbuilt targets have no invented
hashes. The upstream MIT license is retained as `electron-dist/OPENCODE-LICENSE`.

The source patch also ensures Anthropic tool definitions have a root object schema
without root `anyOf`, `oneOf`, or `allOf`.
Native-v2 forwards MCP tool schemas directly through `packages/ai`; a tool with an
empty root schema otherwise reaches Claude without `input_schema.type` and the
provider rejects the entire turn. The older server fetch plugin does not handle
native-v2 requests, so this normalization belongs at the native protocol boundary.

The following helper remains the **beta development/test** preparation path.
It is loaded after the headless v2 and server builds; its memory plugin imports
the built headless v2 client. Use dedicated staging, never a coworker home:

```js
import nativeRuntime from "../native-runtime.json" with { type: "json" };
const { prepareNativePluginBundles } = await import("../electron/prepare-native-plugins.mjs");

await prepareNativePluginBundles({
  outputDirectory: path.join(coworkerRoot, "resources", "native-plugins"),
  dependencyDirectory: path.join(buildCache, `coworker-plugin-sdk-${nativeRuntime.opencodeV2Version}`),
});
```

The helper verifies or installs the exact SDK dependencies once in isolated build
staging, with scripts disabled and its own pnpm workspace boundary. It bundles
nine self-contained ESM files with esbuild, including Events and Abilities,
refuses external package imports, and writes an integrity manifest. Required versions: plugin/schema
`0.0.0-beta-19271`, Effect `4.0.0-rc.112`, Zod `4.1.8`.

Release metadata verified September 11, 2026: CLI/plugin/schema beta tags all
resolve to `0.0.0-beta-19271`. All eight existing native platform tarballs are
published; their exact registry URLs and SHA-512 values are pinned in
`apps/server/src/opencode-v2-artifacts-beta19271.json`. The v1 pin is unchanged. The published
Effect tool, agent-editor and session-hook contracts used here remain compatible;
no native policy or cancellation adapter change was needed for this release.

`apps/coworker/native-runtime.json` retains the beta development/test pin and
selects the source packaging profile. Packaged startup instead verifies
`sidecars/native-receipt.json` against the bundled immutable `native-source.json`,
the real executable header/hash and every plugin byte. It passes that verified
`{ sourceBuild: { version, sha256 }, apiContract: "native-2" }` to the embedded
server. There is no startup compiler, SDK installation, arbitrary binary URL,
development-manifest environment override or beta fallback. The build strips the
test-only source fixture implementation from Electron main. Plugin and SDK package
metadata describes bundled inputs, not dependencies installed on a person's machine.
The shared `constants.json` and `opencode-v2-artifacts.json` retain Desktop's
beta19086 optional-v2 default, and the shared release installer is unchanged.
The server adds an explicit verified source profile alongside those release pins.

CI prepares the source cache in a nonsigning step with an isolated allowlisted
environment and no Apple secrets. The existing signing step requires that cache.
The macOS sign hook verifies the unsigned payload, signs its one native engine
using electron-builder's resolved identity/keychain/options, updates the external
receipt and plugin manifest with the final signed hash, then invokes the existing
app signer. Only that already-signed engine is excluded from a second signing pass;
strict engine/app verification, helper checks and the existing afterSign notarization
remain in force. Windows/Linux matrix checks remain enabled; only macOS ARM64
assembly has been run locally. Signed CI and packaged runtime journeys remain
separate proof obligations.

Packaging must copy that output directory as an extra resource named
`native-plugins`, **outside asar**. Do not copy the dependency staging directory.
Main initializes the runtime writer before any workspace preparation:

```js
import { configureNativePluginBundles, verifyNativePluginBundles } from "./native-plugin.mjs";
import { verifyPackagedNativeRuntime } from "./packaged-native-runtime.mjs";

const { sourceBuild } = verifyPackagedNativeRuntime(process.resourcesPath);
configureNativePluginBundles(path.join(process.resourcesPath, "native-plugins"), { sourceBuild });
await verifyNativePluginBundles();
```

Do not import the build helper into main. There is no runtime package installer.
`OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR` is an equivalent explicit development/test
setting. Missing, mismatched or corrupt bundles fail startup rather than falling
back to raw sources, another SDK, or v1.

Coworker imports the Node/Electron-only `apps/server/src/embedded-native.ts`
entry, which refuses v1 and Bun hosts. The shared server loads the legacy SDK
only while initializing a non-v2 host; its normal synchronous route clients and
standalone build remain intact. Node SQLite does not load the Bun-only ORM.
`stageNativeServer` copies the server first, relocates constants only in that
copy, and writes a native-only package manifest rather than advertising the
legacy CLI. Coworker's browser executor comes from `@openwork/browser-tabs/tools`
with `ws` external and its third-party notice retained; Desktop's broker remains
unchanged. Packaged Coworker requires its bundled native executable and cannot
silently download a replacement when that resource is missing.

`pnpm --filter @openwork/coworker pretest` builds the headless prerequisite and
prepares these bundles before the tests import the native SDK. With no CLI paths,
`prepare-native-plugins.mjs` uses `resources/native-plugins` and the versioned
`resources/sidecars/.native-plugin-sdk-<version>` cache. The contract test uses
that same cache by default; explicit test directory overrides remain available.
This preparation never starts an engine or installs dependencies into a profile.

Existing installer signatures are unchanged:

```js
const connection = { url: contextUrl, token: coworkerToken };
await installCollaborationPlugin(coworker, connection);
// Also installs the native turn-role package.
await installComputerPlugin(coworker);
await installBrowserPlugin(coworker);
await installGroupDocumentPlugin(coworker);
await installEventPlugin(coworker);
await installAbilitiesPlugin(coworker, connection);

const coordinator = await ensureCoordinatorHome(coworkersDir);
await installProgressPlugin(coordinator);
await installMemoryPlugin(coordinator);
```

Install before native warming. The coordinator ensure operation restores its
closed config, so its installers follow it. Runtime installation copies verified
bundled bytes into `.opencode/coworker-plugins/<name>/server.js` with a tiny
dependency-free ESM package descriptor. **Beta19271 configured local plugins must
be directories, not file URLs pointing at JavaScript files.** Old exact managed
file registrations are retired; old files and user package manifests remain.

The native warm path must POST `/api/plugin/await-activation` at the workspace
location and inspect `/api/plugin` for failures before declaring readiness.
Through OpenWork these use `/workspace/:id/opencode2/api/...`. Activation is
asynchronous; an immediate empty inventory does not mean plugins are absent.

## Main Role Selection

```js
import { nativeTurnAgent, NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";

const { tools, ...turn } = input; // Leave the persisted input/legacy mask intact.
const agent = nativeTurnAgent({ tools, agent: turn.agent ?? clientDefaultAgent });
await client.sendTurn(threadId, { ...turn, agent });
```

`nativeTurnAgent({ tools, agent = "build" })` returns a string; it never selects a
model, edits a record, or grants access. Unknown/partial masks, non-boolean values,
masked custom agents, and conflicting existing role pins throw. Empty masks
preserve the supplied agent, including summary/memory roles. Keep the existing
explicit model and message pins. Resolve a new model through the existing
discussion/Worker/responsibility policy, not from an unprepared role placeholder.

| Exact Existing Mask | Native Agent |
|---|---|
| `COMPUTER_DENY` | `coworker-no-computer` |
| `{ coworker_team_refer: false }` | `coworker-no-referral` |
| Both masks merged | `coworker-group` |
| `workerTurnTools()` | `coworker-worker` |
| `workerTurnTools("browser")` | `coworker-worker-browser` |
| `workerTurnTools("computer")` | `coworker-worker-computer` |

The finite role set additionally covers `EVENT_WRITE_DENY` and
`EVENT_SCHEDULE_DENY`, plus group/referral conclusion masks. A true conclusion
entry never grants a permission denied by the configured build agent. Event
context, reply budgets and participant identity remain owned by Event execution,
not inferred from a role name. Activity publication/read state and confirmed Stop's
`onExecutionEnd(entry, snapshot)` handoff remain on the existing lifecycle.

An explicit `NATIVE_COORDINATOR_AGENT` (`coworker-coordinator`) also accepts its
`COMPUTER_DENY` and matching Event-deny masks without weakening its all-tools-denied config. Main
should use that default for coordinator clients, not `build`. Select the same
role and explicit model when creating Worker/responsibility sessions, then send
the native turn without `tools`.

`collaboration.mjs` now stores/selects `entry.agent` for new work and sends that
pin, never the legacy tools field. It retains `entry.tools` as provenance.
Already-admitted recovery never invents/reselects a missing role; it observes
existing work and refuses a resend without a pin. Group facilitator creation and
dispatch explicitly use the coordinator agent. Main selects native roles for its
direct Worker and responsibility dispatches as well. `native-recovery.mjs` gates
collaboration/Worker completion on the exact native success receipt and persists
attempted admission before sending. Inbox-only acceptance is observed, never
replayed; missing phase with prior retry history remains uncertain. New Worker
pending turns persist `prepared` atomically. Stop and cleanup share one promise;
a failed Worker retains its pending turn/barrier until native drain is confirmed.
Overlapping inbox/history reads get two bounded observation retries, never a new
admission. Context-only recovery cancels only an exact owned pending synthetic
input with unchanged history/model/agent boundaries; foreign work is untouched.

Fresh ordinary admissions also persist a host-owned Cloud-skill account/scope
receipt. Workers may attach natively discovered skills without requiring composer
chips; resolution checks that origin through every account/catalog await. Recovery
never mints today's provenance for an old turn. The mandatory-v2 server rechecks
selected-skill permissions after preparation and rejects ask/deny before forwarding.
Consultation requires the exact active tool and raw arguments before normalization.

Native config applies after external plugin setup in beta19271. Role registration
therefore starts closed. The host must await final inheritance **before session
binding and selected-skill permission preflight**, not just the first prompt:

1. Install/register plugins, POST `/api/plugin/await-activation`, and verify the
   required plugins are active.
2. Await `prepareNativeTurnRoles(request)`, which POSTs
   `/api/rpc/coworker.turn-roles/prepare` with `{ "input": {} }` in the same native
   workspace location. Only `{ "output": { "ready": true } }` is success.
3. Mark the workspace warm, then create/bind the Worker session and let the
   headless client's normal selected-skill preflight evaluate native permissions.

`runCoworkerWorkspaceWarmup` awaits this barrier before recording warmth;
`readyWorkerClient` awaits workspace warmth before returning the client. Failed
or incomplete readiness leaves the workspace unwarmed. The RPC checks that
`opencode.config.agent` is active, installs the final configured inheritance,
and verifies every role's permission rules before returning. It accepts no role,
permission, model or skill overrides and is not a model tool. Repeated/concurrent
RPC calls and the retained prompt fallback share one cached registration.

The final transform replays after config changes and clones the **configured**
build agent, appending only denies. No unconditional skill allow is added.
Selected Worker controls mean omission of that role's deny, never a new allow.
Unprepared roles cannot dispatch model/tool work.

Verified against the published beta19271 SDK and core package: `SessionHooks`
contains prompt/context/model/HTTP/retry hooks, not session-create or permission
hooks. `permission.evaluate` is supported, but core returns configured denies
before invoking it; it cannot prepare a deny-all placeholder. `session.created`
is an event-stream notification, not an awaited admission barrier. Plugin
activation is sequential (built-ins, external packages, post-config plugins).
The explicit host/RPC boundary avoids relying on an event race or changing native
permission results.

September 11, 2026 cold-start regression proof: the existing engine smoke uses
the updated headless selected-skills preflight and an explicit native local skill.
Before any ordinary Worker prompt, a cold workspace with configured build deny
rejects admission with zero provider requests; another cold workspace with the
specific configured build allow includes the selected body in its first model
request. Its permission rules equal configured build plus role denies. The warmup
contract test executes main's actual warmup body and proves it waits for readiness
and refuses failed/incomplete receipts. Rebuilt isolated beta19271 bundles passed:
native smoke 3/3 (parent plus both cold cases), SDK/config/bootstrap 5/5, no skips.
The original cold-allow witness was red (`skill_denied`) before the barrier.
Existing real-loopback Code Mode, alias, execute-deny, control, cancellation and
isolated-inference assertions remain green. This is native-engine and extracted
warmup-function proof, not a packaged Electron launch. No server/headless build,
real profile, paid provider or Cloud call was used. **UI/UX impact:** none — the
existing selected-skill UI and configured permission choices are preserved.

Worker roles deny subagents, questions, delegation, management mutations and
every unselected control surface. Role-sensitive tools are direct rather than
Code Mode tools; execution wrappers and native hooks also enforce the role for
aliases. Standard document and permitted read tools remain available.

## Native Abilities

Saved `local:<location>`, `cloud:<capability>` and `mcp:<server>` selections retain
their identity. `abilities.mjs` maps native skill IDs to those records without
copying skill bodies or credentials into the catalog. The native plugin checks
skill permission evaluation, attached skills at prompt admission, and MCP
execution wrappers including Code Mode leaves. It adds no unconditional allow;
all/all preserves the existing broad tools and avoids unnecessary catalog work.
This remains personal tool configuration, not an authorization sandbox.

For admission checks, the plugin supplies native skill metadata it already owns.
Main's `readCatalog(coworker, nativeSkills)` must bypass the UI catalog cache and
pass that metadata through, rather than recursively calling the host skill proxy
from inside its own admission barrier. UI catalog caching remains separate.
Native MCP inventory reads `mcp.servers`, normalizes `disabled`, and applies the
native permission dialect; default Desktop and optional-preview parsing remains
unchanged. Runtime MCP edits remain DB-owned rather than rewriting project files.

## Native Code Mode

Native `execute` is core, not blanket-disabled. The app-generated `coworker`
loopback registration explicitly sets `codemode: true`. The turn-role transform
admits only these ordinary reads from the native `coworker` MCP namespace:

- `coworker_documents_list`, `coworker_document_read`
- `coworker_self_read`, `coworker_team_list`, `coworker_assignments_list`
- `coworker_workers_list`, `coworker_worker_findings`

Unclassified new `coworker_*` tools default to direct. All Coworker mutations
remain direct, including `coworker_document_create`, `coworker_document_update`,
`coworker_document_archive` and `coworker_context_set`, preserving their individual
receipts for the existing document cards/folding. Ordinary native/third-party
Code Mode defaults and explicit `codemode: false` are preserved; the transform
never adds an `execute` permission allow. Canonical permission actions survive
renaming, and execution wrappers retain the original role deny even through
aliases created after the transform. An inherited configured `execute` deny
continues to block Code Mode entirely.

Every `brokerTool` over `/context` stays `codemode: false`, including reads. Exact
native tool IDs (these are **not** Code Mode paths):

- Browser: `coworker_browser_open`, `coworker_browser_tabs`,
  `coworker_browser_close`, `coworker_browser_handoff`,
  `coworker_browser_snapshot`, `coworker_browser_click`, `coworker_browser_fill`,
  `coworker_browser_eval`, `coworker_browser_navigate`, `coworker_browser_screenshot`.
- Computer: `coworker_computer_discover`, `coworker_computer_open`,
  `coworker_computer_observe`, `coworker_computer_act`,
  `coworker_computer_status`, `coworker_computer_close`.
- Delegation/management: `coworker_team_consult`, `coworker_worker_spawn`,
  `coworker_worker_steer`, `coworker_worker_pause`, `coworker_worker_resume`,
  `coworker_worker_cancel`.
- Shared documents: `coworker_group_documents`, `coworker_group_document_read`,
  `coworker_group_document_revisions`, `coworker_group_document_save`,
  `coworker_group_document_restore`.

Disk migration upgrades the old app-owned `false` only for the exact generated
remote shape: `coworker` name, HTTP `127.0.0.1:<port>/mcp`, OAuth off, one bearer
header matching `.opencode/coworker-context.json`, and that connection's identical
origin at `/context`. Additional server fields, missing/malformed evidence,
mismatched tokens/origins and other server names keep their existing policy.
This covers legacy and already-native config and keeps the first backup/idempotent
write contract. Stale launch registrations acquire the new policy through the
app's normal registration refresh; they are not bulk-flipped by name.

Operating guidance lives only in the native turn-role plugin and is appended for
`build`/Coworker roles when `execute` is available. It directs eligible multi-read
work to native execution and the live native catalog without copying an inventory
into prompts. It does not alter isolated inference or enable a denied tool.

September 11, 2026 proof on the dirty `ec27f1bd9` migration: the existing native
engine smoke uses the actual authenticated `createCoworkerToolsServer` and document
handlers. Both `build` and `coworker-worker` perform list + read inside `execute`
and return a filtered, combined result from seeded documents. Protected attempts
produce zero MCP-handler/broker effects, including document writes, controls,
delegation, management, aliases, an explicitly direct third-party tool and an
unclassified new tool. Configured `execute` denial is exercised for both roles.
Existing control variants, file images, exact-call cancellation, coordinator and
isolated inference assertions remain. The full build catalog required increasing
only the fixture model's context from 32k to 128k after its initial compaction
failure; no product model policy changed. Rebuilt isolated bundles and the
verified beta19271 macOS ARM64 binary passed: engine 1/1, SDK/config 5/5, no skips.
No server build, real profile, paid provider or Cloud call was used. Packaged
Electron/renderer document-card proof remains outside this smoke.

**UI/UX impact:** no new controls or layout/copy changes. Eligible ordinary MCP
read sequences now run through native `execute`; mutations retain direct receipts.

## Native Contracts And Preservation

Generated modules use `Plugin.define({ id, effect })`, native transforms/hooks,
and real Effect cancellation. Native session/message IDs and tool `context.id`
reach the existing broker unchanged (`id` is serialized as its `callID` field).
Only `ctx.location.directory` supplies the directory. Broker identity, exact
running-tool input, membership, approval and control-ownership checks are unchanged.
Control cancellation aborts transport and drains a bounded identical-call cancel;
uncertain cleanup is not reported as confirmed Stop. No action is replayed.

Tool results use native content/metadata, including file-image `uri` values.
Bundled Zod schemas use the native-supported Standard Schema interface: relying
on native `instanceof` against a separately bundled Zod copy would lose schemas.

The runtime mirror must preserve native `plugins`, `agents`, `permissions`, and
`mcp.servers`, without a v1 DTO round-trip. Preserve the authenticated standard
`coworker` loopback MCP for documents/self-memory/team/assignments, with
`codemode: true`, the read-only Code Mode allowlist above, and its existing
Worker-management duplicate exclusions. Keep
the actual coworker location, not the mirror directory, as the broker identity.

Config migration is atomic/serialized and retains original bytes once in
`opencode.json.pre-v2.bak`. Malformed or unsupported legacy config fails unchanged.
Soul, memory, documents, unrelated plugins and package files are not rewritten.
Custom legacy provider/command/mode configurations and third-party v1 plugins
still require explicit migration; preserving them is not a compatibility claim.

## Team Location Candidate — Admission Gated

The single-location candidate registers the team's `.runtime` directory for new sessions. Existing
coworker workspace IDs and legacy descriptors are retained, not rewritten or
removed. Explicit history reads use the original location; background activity
avoids opening dormant legacy locations. Legacy input preparation is on demand.

`team-sessions.mjs` persists host-owned session bindings outside the engine location.
Bindings contain the coworker creation identity, logical and native workspace IDs,
original directory and work classification. Scoped tools and abilities resolve
against those bindings and the host's current execution/model/role receipt, never
native session metadata or agent-name prefixes. Unknown, retired and replaced
owners fail closed. A new unassigned session can be classified once by the host.

`team-workspace.mjs` emits model-independent `coworker-owner-<slug>` agent entries.
Home context is bounded and read per turn without configuration rewrites. Supported
per-home `permissions` and `agents.build.permissions` are copied without rebasing
resources or rewriting the original config. Conflicting global-build/owner policy
combinations fail closed rather than changing precedence. Changed team configuration
requires native reload/revalidation; model preferences alone do not change those
bytes. Other per-home agents, instructions, providers and nonstandard integrations
still fail closed where unsupported.

The abilities plugin now uses the trusted `tool.execute.before` hook. Only an
actual invocation carrying both `filesystemScopeVersion: 1` and
`filesystemScopeProjectResolution: 1` can receive the host-resolved
`filesystemScope` (canonical owner directory). Native project resolution registers
fresh owners without activating their locations. Native
validation and execution consume the frozen scope for built-ins, including shell
parsing and permission persistence. Arguments, agent names and session metadata do
not select the owner. Generated peer-denial rules and search/shell path rewriting
are no longer used. Broad shell remains broad shell; native external-directory
approval is preserved instead of replaced with a claimed sandbox.

Role readiness advertises that the scope hook is required, not that the engine
supports it. Old runtimes lacking the invocation marker refuse every shared tool
before its original executor runs. No package version or saved metadata enables
the capability. Shared Coworker MCP reads remain direct pending separate nested
receipt support; native filesystem tools are covered through direct and Code Mode
invocations.

### Matching source-runtime proof

`OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST` selects the separate source case in
`native-plugin-engine.test.mjs`. `native-source-fixture.mjs` checks the executable
SHA-256 and built SDK contract hashes, bundles the matching `@opencode/plugin` and
`@opencode/schema` 2.0.5 directories, and writes disposable fixture artifacts.
`OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST_SHA256` optionally pins the manifest too.
Prepared bundles use `coworker-native-source-plugins/v1`, never a beta19271 release
manifest, and require a matching explicit source build at installation.

The test starts the actual embedded server with isolated HOME/XDG storage and a
loopback model. It exercises three fresh owners without project preregistration,
concurrent home scope, follow-up, configured denies, native approval rejection
without Stop or another model request, Code Mode filesystem scope, forged metadata
rejection, host-authorized MCP reads, live teammate addition, and provider rotation
without replacing the native process. Model-only saves leave team config unchanged.

The additive `native-2` client contract supports experimental wait routes,
permission `decision` payloads, validated idle markers, queued receipt
`time.created` normalization and PATCH session renaming. Conflicting history/active
observations retry within the existing bound, without replay. Experimental session
operations retain the original host binding, including legacy locations.

`native-api-profile.ts` verifies explicit executable hashes and separates source
builds from known release pins. Embedded preparation polls the public plugin
inventory, uses native-2 MCP/instruction routes, maps provider packages and preserves
no-op provider configuration. Provider setup uses the registered team location
without depending on conversation-role preparation; sends retain that preparation.

September 17, 2026: the registered source Electron journey passed with a fresh
isolated profile, three teammates, loopback provider setup/refresh, a visible first
reply and a same-discussion follow-up. React development lifecycle replay no longer
aborts the pending first send; actual view unmount still cancels its observer.
Run only this case through the existing testkit:

```sh
OPENWORK_EVAL_ELECTRON_BINARY=/absolute/source/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST=/absolute/build-manifest.json \
pnpm evals:e2e open-coworker-local-first --local --engine v2 --case COWORKER-SHARED
```

The world refuses installed app binaries, uses temporary explicit app/storage
paths and disables protocol registration. The source bootstrap is development-only
and refuses packaged-app overrides. No credentials or real provider requests are
needed. This is source Electron plus embedded-server proof, not packaged proof.

### Remaining integration and packaging requirements

Packaging now builds the verified immutable upstream source plus the checked-in
patch and matching SDK; no separately published native release is required.
The corrected unsigned ARM64 package passes the unchanged private-path gate,
receipt/file-list checks and size budget. A copy outside the checkout passed
archive import, native startup/health, activation of all nine Coworker plugins
and cleanup under a macOS sandbox denying reads of the build checkout and native
source clones. See RELEASE-SIZE for the exact artifact and verification limits.
The installed alpha has not been changed. Upgrade,
shared browser/computer controls, signed distribution and packaged lifecycle
validation remain separate.
Unbound native child sessions remain refused; no session-move API or automatic
history migration is used. These fixtures do not install an app or build an alpha.
The broader evals typecheck and layer lint remain red outside the new source case;
passing runtime checks do not clear those repository-wide gates.

## Isolated Inference And Proof

Progress/memory helpers retain `(client, model, { prompt, signal })`. Their agents
are registered only by loaded plugins, not persisted config fallbacks. Native
hooks strip ambient input/history/tools, bind the exact model, cap output at
80/1000 tokens, and permit one primary HTTP request with zero retries. Native
`default` variant normalization is accepted; non-default variants and unknown
pricing/transport shapes remain refused. Results require correlated successful
native execution. Native metadata does not prove the old `reasoning: false`
flag; upstream eligibility stays conservative, with existing local fallback.

The executable native smoke requires an absolute binary installed through the
repository's `installOpencodeV2Binary` with the current artifact pin, and checks
its exact `--version` output before startup. It uses isolated HOME/XDG/config,
only a loopback provider and broker, and no workspace node_modules. It proves
actual package activation, inherited denies, Worker control variants, retained
document access, useful MCP Code Mode plus protected-tool denial, file images, native cancellation, both isolated
inference paths and the single-request 429 boundary. Example:

```sh
node apps/coworker/electron/prepare-native-plugins.mjs /absolute/bundles /absolute/sdk-staging
OPENWORK_TEST_NATIVE_V2_BIN=/absolute/opencode2 \
OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR=/absolute/bundles \
COWORKER_NATIVE_PLUGIN_TEST_ROOT=/absolute/sdk-staging \
node --test apps/coworker/electron/native-plugin-engine.test.mjs
```

This is actual native-engine proof, not signed-installer or real OS-control proof.
On September 11, the beta19271 macOS ARM64 engine smoke passed (1 test, no skips),
as did the published-SDK contract/bootstrap checks (5 tests, no skips), using only
deterministic loopback fixtures. Bootstrap coverage includes dev/build ordering
and importing packaging hooks without loading plugin preparation.
The complete Electron startup/packaging integration is still the main owner's
step. No renderer/navigation/copy changes are included; policy enforcement and
failure-closed readiness are the intended integration changes.
