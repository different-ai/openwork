# OpenWork tests and test evidence

All executable coverage lives in [`specs/**/*.test.ts`](./specs) and imports
`test` from `@openwork/testkit`. Tests that drive Electron, Den, or another app
surface use `.e2e.test.ts`.

## Paved path

Use the skills in this order:

1. `write-a-spec`
2. `run-tests`
3. `diagnose-a-red-run` when the run fails
4. `publish-evidence` for the existing ambient test evidence

Demo-driven features start from a world script plus a spec in `evals/specs`.

## Glossary

| Term | Meaning |
| --- | --- |
| world | An executable TypeScript script that creates and holds concrete resources. |
| receipt | PID ownership metadata for a detached script world. |
| place | Where launched resources run: `local` or `daytona`. |
| substrate | What runs the Den control plane: local processes or `kind`. |
| witness | A deterministic provider stand-in that records what it saw. |
| fault | Declared misbehavior used to reproduce a failure condition. |
| surface | A drivable UI: Electron, or Chrome on Den Web. |
| origin | Whether a resource is launched or attached. See below. |
| live | A spec attached to a live shared substrate; red is an incident signal about the service, not a verdict on the diff. |

### Resource ownership

The script's `AsyncDisposableStack` owns what the script creates and disposes it
in reverse order. Attached or shared resources expose handles whose disposers
release only script-owned additions, such as local port-forwards or an
organization created for that run; they do not stop or delete the shared
substrate. The rule is: **the stack owns what the script creates, not what it
attaches to.**

## Skills map

Skills own mechanics; this README owns the map and vocabulary.

| Task | Skill to load | When |
| --- | --- | --- |
| Author a spec | `write-a-spec` | Add executable coverage under `evals/specs`. |
| Run tests | `run-tests` | Run a selected spec; the CLI chooses and reports placement. |
| Failing or red run | `diagnose-a-red-run` | Classify a failure before changing code. |
| Publish evidence or declare a PR verdict | `publish-evidence` | Judge and publish an existing ambient evidence run. |
| Missing secret or environment variable | `get-env-var` | Load a required team secret into the shell. |
| Drive local Electron via CDP | `browser-automation` | Explore or debug the local desktop surface. |
| Daytona setup or sandbox debugging | `daytona` | Repair the CLI, snapshots, sandboxes, or secrets volume. |
| Demo artifacts | `record-a-demo` | Capture supplementary screenshots or recordings. |

## Install and run

`evals/` is a standalone pnpm workspace so its tooling cannot affect product
installs or image builds.

```bash
pnpm --dir evals install
pnpm evals:pr
pnpm evals:e2e app-smoke
```

### E2E CLI

Run the E2E lane with `pnpm evals:e2e [test-names...]`. Naming a test
auto-satisfies the opt-in flags declared in its source, but value-bearing
environment variables such as `OPENWORK_EVAL_MODEL` are never auto-set. Vision
judging is deferred by default; add `--with-llm-vision` to judge inline. Use
`--local` to force isolated local resources, `--daytona` to require Daytona,
`--den <url>` to reuse Den, or `--publish --pr <number>` to judge and publish
existing evidence. Without a placement flag, the CLI probes Daytona auth and
prints `placement: <daytona|local> (<reason>)` for its selection.

| Exit | Named test | Unfiltered E2E suite | Publish |
| --- | --- | --- | --- |
| `0` | Passed | Passed, or incomplete with expected skips | Published |
| `1` | Failed | Failed | Failed claims published, or publish failed |
| `2` | Incomplete because it skipped | Not used | Claims pending judgment |

See `run-tests` for environment requirements and the cold-boot verdict check.

Every `evals/specs/*.e2e.test.ts` file on disk runs in the E2E lane. To stop a
spec from running, delete it; history keeps the removed test available.

### Live lane

Surface and substrate are independent axes:

| Surface | Launched substrate (world-owned, hermetic) | Attached live substrate |
| --- | --- | --- |
| App-less | `<slug>.test.ts` | `<slug>.live.test.ts` |
| App-driving | `<slug>.e2e.test.ts` | Not yet paved |

Run a live spec only by exact name and with explicit consent and endpoint values:

```bash
OPENWORK_EVAL_LIVE=1 OPENWORK_EVAL_LIVE_DEN_API_URL=https://api.openworklabs.com OPENWORK_EVAL_SECRET_LIVE_MAILBOX_EMAIL=<mailbox> pnpm evals:pr specs/prod-den-signup-invites.live.test.ts
```

The live Den is attached and never deleted. Timestamped plus-addressed identities,
organizations, and invitations launched onto it are owned by the spec; cleanup is
asserted even on failure, and any residue (including an account without a
self-service deletion endpoint) must be documented with exact identities.

## Authoring contract

The spec boundary ratchet (`scripts/spec-boundary-ratchet.mjs`) rejects new
files that import product source (`../../apps|packages|ee`) or that never cross
a product boundary (`app()`, `coworker()`, `chrome()`, `server()`,
`spec.world()`, or a world import); a file with no boundary is also called out for `node:fs` and
`node:child_process`. Its `specs/boundary-ratchet.baseline.json`
grandfathers legacy files and only shrinks. Cleanup deletes them, moves unit
tests next to their module, or folds their assertions into a journey spec.

- Import `test` from `@openwork/testkit`.
- Name app-driving files `<slug>.e2e.test.ts`; app-less tests use `<slug>.test.ts`.
- Live specs use `<slug>.live.test.ts`, never run in PR/E2E suites, and require a consent environment variable.
- Acquire resources in dependency order with `needs()` → `server()` → `app()`.
- Drive user-visible behavior and assert observable outcomes. Backend, file,
  and process checks may witness side effects but do not replace the journey.
- Bound every wait and declare external requirements in `needs()` so missing
  dependencies skip with a named reason.
- Assert both positive and negative sides of identity or permission boundaries.

## Writing specs

New app-driving specs use `spec.world()` and four capability-restricted
channels. Import them only from `@openwork/testkit`.

| Channel | Purpose | Allowed effects |
| --- | --- | --- |
| `seed` | Arrange the world | Create Den, desktops, browsers, data, mocks, sessions, and faults; this is the only API/state write channel. |
| `user` | Act as a person | Trusted CDP mouse, keyboard, navigation, reload, visible assertions, screenshots, and vision checks. It cannot evaluate JS, fetch, or use app controls. |
| `agent` | Use the product automation rail | Explicit `window.__openworkControl` actions, including agent sends and session actions. |
| `probe` | Observe without changing state | Read text, composer/storage/hash/API/witness state, and poll with `eventually`. Probe API calls are GET-only. |

A world is an imperative async function. Resources created through `seed` are
owned by the fixture's `AsyncDisposableStack` and released in reverse order.
Worlds are per-test by default; `{ scope: "file" }` shares exactly the handles
the world returns. E2E files automatically need
`OPENWORK_EVAL_E2E_TESTS=1`, and unmet needs skip before the world starts.

```ts
export async function emptySession(seed: Seed) {
  const app = await seed.desktop();
  await seed.workspace(app, seed.tmpPath("empty-session"));
  await seed.session(app);
  return { app };
}
```

`app` and `web` are conventional primary surface names. If the returned world
has one of them (or exactly one surface), channel calls use it by default;
otherwise bind explicitly with `user.on(surface)`, `agent.on(surface)`, or
`probe.on(surface)`.

Use `step(name, fn)` for a claim-sized frame. Steps may nest; failures are
recorded and rethrown, and a later attempted step is marked `not-reached`.
Every channel call and step automatically contributes a chronological evidence
trace and the body wrapper records the passed, failed, or skipped outcome.

The body call-order rule prevents accidental setup disguised as user behavior:
`seed.*` before the first `user.*` or `agent.*` act throws. Put that setup in the
world. Mid-flow seeding after an act is explicit and allowed; probes do not
change the ordering state.

`seed.evalIn()` (`[seed:raw]`) and `probe.eval()` (`[probe:raw]`) are migration
escape hatches. Both accept `{ awaitPromise?: boolean, timeoutMs?: number }`;
`probe.eval` accepts the options after either `(expression)` or
`(surface, expression)`. New specs must not use them. The channel ratchet
records current legacy usage per E2E file and fails on increases or stale
baseline entries.

Before, composer reload coverage imported hosts, behaviors, CDP evaluation, and
evidence APIs directly. After, the journey is only:

```ts
const test = spec.world(emptySession);
test("a draft survives reloads", async ({ user, probe, step }) => {
  await user.type("composer", "Keep this draft");
  const revision = await probe.storage("openwork.session-drafts.v2", pickRevision);
  await step("draft survives three reloads", async () => {
    for (let i = 0; i < 3; i += 1) {
      await user.reload();
      await user.see("composer", { editable: true, text: "Keep this draft" });
    }
  });
  expect(await probe.storage("openwork.session-drafts.v2", pickRevision)).toBe(revision);
});
```

`"composer"` is the documented well-known target for the Lexical
`[contenteditable="true"][data-lexical-editor="true"]` editor. Other targets use
accessible name, role, label, placeholder, test ID, and optional `nth`; `text`
and `label` accept strings or regular expressions. A unique visible element
whose inner text starts with a string is the fallback for a non-exact text/name
match.

`user.type(target, text)` appends by default. Pass `{ replace: true }` to focus
with a real click, select all with the platform key chord, and replace the
current value. `user.see(target, { text })` compares contenteditable inner text
and accepts a string or regular expression. Clicks require center-point hit
testing; `{ hitTest: false }` is a last resort for an intentionally covered
target and still performs a trusted CDP click at that element's center.

Worlds can arrange a shaped Den connection with `seed.denLink(den, options)`;
the returned link is fixture-owned. `probe.connectState(app)` reads the
testkit's normalized desktop Connect state without exposing the raw helper to a
spec.

## Layers

Imports only point down: a layer may use lower layers, never a higher layer.
This is enforced by `pnpm --dir evals run lint:layers`.

| Layer | Contents | Rule |
| --- | --- | --- |
| L0 | `@openwork/matchers` | Turn supplied facts into pure findings; no I/O. |
| L1 | `@openwork/cdp`, `@openwork/labs` | Provide protocol and lab primitives; do not own journeys or test lifecycle. |
| L2 | `@openwork/behaviors` | Provide framework-free actions and observations over narrow handles. |
| L3 | root `@openwork/world` + `@openwork/env` | The shared package owns script discovery, CLI receipts, and the headless-web surface; env provides concrete eval resources. Neither depends on Vitest. |
| L4 | `@openwork/testkit` and `evals/bin/evals.mjs` | Adapt environments to specs, Vitest, and evidence. |

## Composable packages and diagnostics

The packages under [`packages/`](./packages) are independently consumable, but
executable coverage is always assembled as a test under `specs/`.

| Package | Owns |
| --- | --- |
| root `@openwork/world` | script discovery, CLI lifecycle receipts, local state store, `hold()`, and headless-web surface |
| `@openwork/env` | places and concrete Den, desktop, mock, LiteLLM, and kind resources |
| `@openwork/testkit` | thin Vitest adapter: fixture, needs/skip mapping, evidence bridging, and spec-facing re-exports |
| `@openwork/cdp` | raw CDP client, targets, `Surface`, and `attachSurface` |
| `@openwork/labs` | egress, identity-provider, release-feed, and mock-MCP labs |
| `@openwork/hosts` | local and Daytona hosts and `resolveHost()` |
| `@openwork/behaviors` | framework-free actions and observations over narrow handles |
| `@openwork/matchers` | pure findings over facts, with no I/O |
| `@openwork/test-evidence` | screenshot capture, visual validation, and ambient test-evidence recording used by testkit |
| `@openwork/timeline` | timing spans for long test journeys |
| `@openwork/test-artifacts` | index, render, and PR publication for completed test runs |

Because behaviors and matchers do not depend on a test context, they also power
the standalone diagnostic script at `evals/scripts/diagnose.mts`. It imports
only `@openwork/behaviors` and `@openwork/matchers` and can inspect a real
endpoint without creating test evidence.

## Worlds

A world is a plain executable TypeScript file under `worlds/`. Each script
creates concrete async resources in dependency order, registers them with a
native `AsyncDisposableStack`, and calls `hold()` after it is ready. Typical
resources are `server`, `createAdmin`, `createOrg`, `inviteMember`, `app`,
`mcpMock`, `liteLlm`, and `launchHeadlessWeb`.

Every checked-in script is guarded by `if (import.meta.main)`. Importing one is
therefore side-effect-free until a caller invokes an exported builder. Specs,
docs tooling, and the script entry point use those same builders; there is no
second lifecycle layer.

Useful ready-made scripts include `worlds/solo.ts`, `worlds/acme-demo.ts`,
`worlds/acme-docs.ts`, and `worlds/desktop-prod-live.ts`. `support-org` no
longer exists. See `pnpm world list` for the complete current set.

Detached scripts write PID ownership receipts to
`evals/results/.worlds/scripts/<name>.json`. A receipt records the script path,
PID, creation time, and non-secret outputs. It is lifecycle metadata, not a
recipe for recreating resources.

### World CLI

The root `pnpm world` command requires Node 24+. Its interactive lifecycle is:

```bash
pnpm world up solo                 # foreground; Ctrl-C disposes its stack
pnpm world up acme-demo --detach   # background; waits for its receipt
pnpm world up acme-docs --detach --timeout 600000
pnpm world down acme-demo          # signal it and wait for native disposal
pnpm world list
pnpm world forget <name>
pnpm world help

# A path or the filename-derived name selects the same script.
pnpm world up ./worlds/dev-headless.ts
pnpm world up ./worlds/litellm-per-member.ts

# Script-specific arguments must follow the separator.
pnpm world up dev-headless --detach -- --replace --keep-tokens
pnpm world up headless-prod-live -- --allow-shared-state
pnpm world up desktop-prod-live -- --allow-shared-state
```

The generic `up` options are only `--detach` and, with detached mode,
`--timeout <ms>`. Everything after `--` is passed unchanged to the selected
script. `down` sends the script a termination signal and waits while its
`AsyncDisposableStack` releases owned resources. `forget` removes receipt
metadata only; it does not stop the process. `help` and `list` discover
`worlds/*.ts`.

`desktop-prod-live` is a deliberately dangerous local-only mode. It launches
source Electron through `pnpm dev` with isolated Electron userData, app
identifier, Vite/CDP ports, and protocol registration, while resolving the
installed production `OPENWORK_DATA_DIR` and channel-aware `OPENCODE_DB` only at
launch time. It never copies or symlinks those stores, does not boot or modify a
Den, and does not seed a workspace, session, or sign-in. Production may remain
running, but concurrent writes from production and dev are unsupported and may
corrupt state. Its parser requires exactly `--allow-shared-state`, after the
`world up` argument separator. Disposal stops only the source dev process and
does not delete shared stores.

`headless-prod-live` applies the same symbolic state selection to source Vite +
`openwork-server` without Electron. Its production tokens, server state, config,
OpenWork data, and OpenCode database are resolved in place and never copied into
the receipt. It requires the same exact script argument and refuses remote
access, public hosts, and non-loopback host bindings.

`worlds/den-split-origin-kind.ts` attaches to the shared
`openwork-kube-lab` kind substrate and owns only its local port-forwards. Run its
opt-in proof on a machine with local Docker, kind, kubectl, and Helm:

```bash
OPENWORK_EVAL_E2E_TESTS=1 OPENWORK_EVAL_KIND_E2E=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e specs/world-kind-den.e2e.test.ts
```

Daytona cannot host this substrate: its sandbox has no Docker binary or daemon,
reports `CapEff: 0000000000000000`, and blocks `unshare -Urm`, so no container
runtime can start kind there.

## Recipes

### Drive the app

Import the script's builder, create one disposal stack, and call the builder.
Compose journeys from `@openwork/behaviors`; executable coverage belongs in
`evals/specs`.

```ts
import { bootAcmeDocs } from "../../worlds/acme-docs.ts";

await using stack = new AsyncDisposableStack();
const world = await bootAcmeDocs(stack, place);
const docs = world.app("docs");
```

### Provision a fresh setup

Compose the same concrete builders directly. The stack owns each resource added
with `use()` and disposes it in reverse order.

```ts
await using stack = new AsyncDisposableStack();
const den = stack.use(await server({ place, provision: false, web: true }));
await createAdmin(den, {});
const org = stack.use(await createOrg(den, "Acme"));
const desktop = stack.use(await app({ den, place, as: "admin" }));
```

### Reproduce a failure

Run the relevant script or exact spec again with the same explicit inputs.
Receipts cannot recreate a run; use their PID, script path, outputs, and paired
log only to inspect or stop the existing detached process.

### Docs screenshots and demos

Docs tooling imports `bootAcmeDocs`; demos use `bootAcmeDemo`. Their standalone
scripts call the same builders, so importing, CLI use, and specs share one
implementation.

## Ambient evidence and verdicts

The testkit fixture opens and closes a test-evidence recorder around each test.
Screenshots become test artifacts, visual validation records their expectations,
and assertion evidence carries witness assertions. Do not create or pass
recorder handles.

Report `Passed` only when every claim has observable evidence in the test run.
A failed assertion is `Failed`; missing requirements, tooling failure, or
missing test evidence is `Incomplete` or a named skip. A green suite containing
skips is not proof.

Publish an already completed test run with the `publish-evidence` skill:

```bash
pnpm evals:e2e --publish --pr <number> [--test-run <path|directory-id|latest|name>]
```

`evals:e2e --publish` judges and publishes test evidence without rerunning tests.
Its optional `--test-run` argument selects an existing test run by path,
directory ID, record name, or `latest` at publish time. Custom screenshots and
recordings are supplementary and never determine the pass/fail verdict.

## Standalone isolated Den

For an isolated Den API without Electron or Den Web, use the development helper:

```bash
pnpm --dir evals dev:den -- up --port 8891 --database openwork_den_my_eval --seed
pnpm --dir evals dev:den -- down --port 8891 --drop-database
```

The port and database are generated when omitted. The helper starts MySQL,
pushes the current schema, and prints the eval URL exports and teardown command.
It also adds the printed `OPENWORK_EVAL_DEN_WEB_URL` to the trusted origins;
without that origin, Better Auth rejects eval sign-in with
`403 INVALID_ORIGIN`.

## Daytona E2E tests

Run a selected test through the E2E CLI:

```bash
pnpm evals:e2e app-smoke
```

Without a placement flag, the CLI uses Daytona when `daytona snapshot list`
succeeds and local otherwise, then prints the placement and reason. `--daytona`
requires Daytona; `--local` forces local.

Set `OPENWORK_EVAL_ENGINE=v2` to run any named spec with the app's chat routed
through the OpenCode v2 sidecar, locally or on Daytona; unset it (or use `v1`)
for the unchanged default. For example,
`OPENWORK_EVAL_ENGINE=v2 pnpm evals:e2e <slug> [--daytona]`. The test-evidence
header records the selected engine.

Use direct CDP tools only to explore or debug. Convert repeatable coverage into
a testkit test.

## CDP manual-debugging tools

The `opencode-chrome-devtools` plugin exposes these browser tools. Every call
takes `browser_url`; target-specific calls also use the selected target ID.

| Tool | Purpose |
| --- | --- |
| `browser_list` | list page targets on a CDP endpoint |
| `browser_navigate` | navigate a target |
| `browser_snapshot` | inspect the accessibility tree and stable UIDs |
| `browser_click` | click a snapshot UID |
| `browser_fill` | fill an input by UID |
| `browser_eval` | inspect state or run debugging JavaScript |
| `browser_screenshot` | capture a PNG checkpoint |

Use these calls for exploration and debugging, not as replacement verdict
evidence. Repeatable executable coverage belongs in a testkit test, where
observable assertions and validated screenshots are recorded as test evidence.

## Reserved names (not implemented)

These names are designed but not built. Do not attempt to use them:

- `attach.den({ url, tier })`
- `attach.user({ secretRef })`
- `attach.sandbox(...)`
- `tier: "prod" | "staging" | "demo"`; the production tier will structurally
  refuse organization provisioning, seeding, and database access.
- `secretRef`; secrets will be named and resolved at start. Snapshots may carry
  secret references, never secret values.

The low-level escape hatch available today is
`OPENWORK_EVAL_DEN_API_URL` with `OPENWORK_EVAL_DEN_WEB_URL`. It attaches an
existing Den at the `server()` level and is called `reuse` in current code.
Attached mode has no `apiLog()` and does not support `seedProfile`. Locally
launched mocks are loopback-only and therefore unreachable from a remote Den.

## Daytona reference

### Ports

| Service | Port |
| --- | ---: |
| noVNC | 6080 |
| Vite HMR | 5173 |
| Electron CDP | 9825 |
| Den Web | 3005 |
| Den API | 8788 |
| Worker proxy | 8789 |
| Artifacts | 8090 |
| MySQL (internal) | 3306 |

### Electron UI selectors

| Control | Stable selector/search | Source |
| --- | --- | --- |
| Settings | `[data-testid="account-status-menu"]`, then `Settings` | `domains/session/sidebar/account-status-menu.tsx` |
| Back to app | button text `Back to app` | `domains/settings/shell/settings-shell.tsx` |
| New task | `button[aria-label="New task"]` | `domains/session/sidebar/app-sidebar.tsx` |
| Run task | button text `Run task` | `domains/session/surface/composer/composer.tsx` |
| Model selector | `button[aria-label="Change model"]` | `domains/session/surface/composer/composer.tsx` |
| Composer | `[contenteditable="true"][data-lexical-editor="true"]` | `domains/session/surface/composer/editor.tsx` |
| AI Providers | button text `AI Providers` | `domains/settings/shell/settings-page.tsx` |
| Connect provider | button text `Connect provider` | `domains/settings/pages/ai-view.tsx` |
| Provider search | `input[placeholder="Filter providers by name or ID"]` | `domains/connections/provider-auth/provider-auth-modal.tsx` |
| Manual key | button containing `Manually enter API Key` | `provider-auth-modal.tsx` |
| API key | `input[type="password"][placeholder="sk-..."]` | `provider-auth-modal.tsx` |
| Save key | button text `Save key` | `provider-auth-modal.tsx` |

### Lexical composer typing

```js
const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
editor.focus()
document.execCommand("selectAll", false, null)
document.execCommand("insertText", false, "YOUR PROMPT HERE")
```

### Two-sandbox Den + Electron

```bash
bash .devcontainer/test-server-on-daytona.sh <ref>
bash .devcontainer/test-on-daytona.sh <ref> \
  --den-base-url <DEN_WEB_URL> \
  --den-api-base-url <DEN_API_URL>
```
