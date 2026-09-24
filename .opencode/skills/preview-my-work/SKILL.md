---
name: preview-my-work
description: Boot, reopen, update, or reset OpenWork PR previews. Discover script worlds, use configurable app-web locally or through a private Daytona browser URL, or choose isolated Den/Electron presets for hands-on testing.
---

# Preview my work

Use the repository's world lifecycle. These are disposable test environments,
not production or a user's installed desktop profile. Do not touch another
world or an existing test sandbox. Run from the requested worktree.

## Choose a preview

- Discover the actual primitives first: `pnpm world help`, `pnpm world list` (declared targets are shown; undeclared scripts cannot run remotely),
  then inspect the requested script in `worlds/` and its options in `worlds/lib/`.
  A preset's restrictions are not restrictions of the generic world CLI.
  For another composition, inspect `packages/world/src/index.ts` and
  `evals/packages/env/src/index.ts` before declaring it unsupported; reuse the
  existing provisioning, runtime launch and hold primitives, not another framework.
- `app-web`: configurable source app plus the existing isolated headless server,
  locally or on an owned private Daytona sandbox. This is not Den's web UI and
  not the Cloud-off `seed.appWeb` test fixture. No Den or activation is seeded.
- `preview-den`: signup, team administration, onboarding, connectors, policies.
- `preview-desktop`: real Electron plus its own Den; workspaces, chat and native
  app interactions. On `--place daytona` this is Linux Electron in a noVNC
  viewer, not a macOS/Windows parity check. `--place local` runs this checkout:
  Den on the local MySQL/Redis and the desktop as a native window on this
  machine (source previews only; `--release` requires Daytona). Freestyle
  supports `app-web`/`acme-web`, not these presets.

For the isolated `preview-den`/`preview-desktop` presets, choose `--scenario fresh`
for signup/first use, `team` for an owner with Notion
and Linear available (individual accounts remain unconnected), `restricted`
for that team with the API's canonical restricted policy values, or `workspace`
for a signed-in desktop workspace without pre-added tools. Fresh desktop is a
true first launch: the harness adds no workspace and does not sign into Den.
Because the preview's own Den is configured through a bootstrap file, the app
behaves like a bootstrapped install and skips the public-download "OpenWork
Chat" starter workspace, so the sidebar shows no workspaces. No model credentials are seeded.
Do not describe these fixtures as capable of live model/provider requests.

Use `--scenario blank --release <x.y.z> --distribution <name>` to preview exact
published Linux x64 tarball bytes with a completely isolated, unseeded profile.
Supported distributions are `public`, `cloud`, and `enterprise`; other
platforms, architectures, package formats, prereleases, and mutable/latest
versions are not supported. The installer resolves the exact `v<x.y.z>` GitHub
release asset and verifies its API-published SHA-256 digest before extraction.

## Start and open

For the configurable app-web script, use a reviewed full pushed SHA on Daytona:

```sh
pnpm world up app-web --place local --stage pr-1234
pnpm world up app-web --place daytona --stage pr-1234 --detach --timeout 600000 -- --ref <full-pushed-sha>
pnpm world outputs app-web --stage pr-1234 --reveal
pnpm world down app-web --stage pr-1234
```

An existing Den proxy is an explicit, nonsecret environment selection, not a
`--cloud` mode. Set values in the caller and select each key with repeatable
generic `--env KEY` **before** the script-argument separator:

```sh
OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=1 \
OPENWORK_DEV_DEN_PROXY_TARGET=https://app.openworklabs.com \
pnpm world up app-web --place daytona --stage pr-1234 --detach --timeout 600000 \
  --env OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY --env OPENWORK_DEV_DEN_PROXY_TARGET \
  -- --ref <full-pushed-sha>
```

Without those selections app-web ignores ambient proxy settings and stays
Cloud-off. Only these two app keys are accepted; the target must be a nonsecret
HTTP(S) origin, selected together with an enabled proxy. Remote app-web initially
allows only `https://app.openworklabs.com`; other targets fail before provisioning.
Local app-web allows custom HTTP(S) origins, including loopback. Direct script
execution without the CLI selection marker stays Cloud-off.
Generic invocation identity fingerprints the selected nonsecret values
before adoption; changing a key, value, placement or script argument requires a
new stage or explicit down. Never pass provider credentials, host/client tokens,
personal profiles, or shared secrets volumes. There is no `--cloud` flag.
The CLI rejects credential-like environment key names. Local invocation identity
also hashes Git HEAD, status, tracked diffs and untracked file names/content;
source changes require a new stage or down before up, across local worlds.

The app-web `webUrl` is a secret, port-bound signed hostname. Reveal it only in a
private terminal and open it directly; never put it in evidence or PR text.
Loopback `runtimeWebUrl`/`runtimeOpenworkUrl` are process diagnostics, not human
browser links. Source SHA and placement are explicit outputs. Private HTTP,
assets and WebSocket access must pass the launch checks; failures delete the
owned sandbox, never fall back to public exposure. The source dev proxy preserves
client bearer auth and never injects host auth. Builds and production preview
servers do not enable this proxy. Checked-out source receives only the non-secret
preview host suffix for Vite allowedHosts, never the signed origin. HMR derives
its host and protocol from the browser location; `/api/openwork` resolves against
that same origin in the browser. Signed URLs stay in the trusted launcher,
witness and private outputs.

Do not claim sign-in is verified. Production handoff rules are unchanged and
arbitrary preview-origin auto-return is not approved. The existing app sign-in
surface has **Paste sign-in code**; if the existing Den flow supplies a one-time
code, paste it directly there. Do not fabricate activation/bootstrap state.
App-web defaults to two hours from readiness; optionally pass `--lifetime <10-1430>`
after `--`. Its signed URL is issued by the trusted launcher before runtime launch, with the
lifetime plus a ten-minute startup buffer (within Daytona's 24-hour maximum).
Startup exceeding that buffer fails closed. `expires` is the authoritative world
deadline from readiness; `previewExpires` is the conservative URL deadline from
issuance. The URL credential can outlive the world timer, but sandbox deletion
invalidates access. World expiry or `down` tears
down the owned runtime and sandbox while the owning driver is running. Always
explicitly stop when finished. Abrupt driver crashes can leave a sandbox behind:
ledger ownership is not authenticated, so no Daytona ledger reaper is registered.
Manual cleanup must independently verify ownership before deleting a sandbox.
The preset update helper below
does not update app-web; use a new stage on the next reviewed SHA instead.

Daytona documents signed hosts as `{port}-{token}.{proxyDomain}`, not sandbox-ID
hosts (https://www.daytona.io/docs/en/preview/). The launcher checks structured
private sandbox info (matching ID, `public: false`) and its `toolboxProxyUrl`
(`https://{proxyDomain}/toolbox`) before
issuing the signed URL; unsupported info formats fail closed. It rejects standard
sandbox UUID hosts and mismatched domains. The opaque signed token cannot prove
sandbox identity by hostname alone; issuance is scoped to the verified sandbox ID.

The following scenario/ref and update instructions concern the isolated presets.

Use a unique stage such as `pr-1234` to keep previews separate. First inspect
`pnpm world list` and `pnpm world outputs <world> --stage <stage> --json`.
An existing matching world should be reopened, not recreated. Compare its
recorded scenario and ref before adopting it. A stage is not a git ref.

Use reviewed repository code: previews execute that ref’s build scripts. Do not
load production credentials or attach shared secrets volumes. Push the intended
commit and use its full 40-character SHA so Daytona can fetch it. When
`OPENWORK_EVAL_REF` is omitted, launch resolves remote `origin/dev` once to a
full SHA, prints it, and records it in the world outputs. This assumes `dev`
is the reviewed baseline. Explicit launch refs and update refs still reject
mutable branch names. To preview a specific commit:

```sh
OPENWORK_EVAL_REF=<pushed-sha> infisical run --silent --env dev -- pnpm world up preview-den --stage pr-1234 --place daytona --detach --timeout 600000 -- --scenario fresh --lifetime 120
```

Substitute `preview-desktop` and the desired scenario as needed. The existing
Daytona snapshots handle dependencies. A cold build takes minutes; reopening a
ready world is quick. Never promise seconds for an unmeasured cold boot.

For an immutable published desktop preview, run:

```sh
pnpm world up preview-desktop --stage pr-1234 --place daytona --detach --timeout 600000 -- --release 0.18.44 --distribution enterprise --scenario blank
```

`OPENWORK_EVAL_REF` pins only the independently provisioned Den source; omit
it to use the current remote `dev` commit, independently of the desktop version.
The world driver and release installer run from the local checkout's HEAD, and
the desktop sandbox uses the snapshot's inherited display/browser helpers.
`--release` selects desktop bytes; none of these identities falls back to
another. For preview recipes only, the equivalent composable inputs before `--`
are `--source desktop=release:0.18.52/enterprise --source den=sha:<full-pushed-sha> --seed blank`.
Do not combine `--source desktop=...` with `-- --release`. `--source den=ref:dev`
resolves origin/dev to a full SHA before adoption; otherwise the CLI pins the
remote dev SHA for Daytona previews. `--os windows` is rejected before provisioning
until an interactive Windows desktop host is wired. Freestyle does not support
Windows or these preview presets. Release sandboxes do not mount shared secrets and do not run a source
checkout, `pnpm install`, Electron source launch, or Vite. Their viewer,
startup observation, release digest, Den URLs, log/profile paths, relaunch
shortcut, browser shortcut, and protocol handler are reported as outputs. A
crashed or unresponsive app is retained for inspection and is not reported as
healthy; CDP is output only when it actually responded.

Read the resulting world outputs. Open `preview` with Codex's `open_in_codex`
browser target when available; do not launch the operating system browser.
Den opens directly; desktop opens the noVNC viewer with automatic connection,
fit-to-panel scaling and reconnect enabled. The viewer toolbar includes
clipboard controls. Keep `denWeb` available for testing both surfaces.
If this agent has no embedded-browser opening tool, give the preview link.

For phone web layouts, use the browser tool's viewport controls if available;
otherwise use the preview's responsive browser tools. Do not call a resized
Electron viewer a mobile app preview.

Wait for world readiness and verify the preview responds before reporting it
ready. If testing behavior, follow `run-tests`; a manually booted world is not a
passing test. Do not print secret outputs or put them in a PR. Test account
passwords are masked; read the owner-only receipt privately when signing in.
For seeded Den scenarios, use the available browser controls to sign in with
that test account before handing the preview to the user. Leave fresh Den at
signup. The desktop team/workspace scenarios already sign in automatically.
Mail stays in this world's development outbox; never send real invitations.

## Update without losing progress

For frontend-only changes, push the new commit and run:

```sh
pnpm exec python3 .opencode/skills/preview-my-work/scripts/update-preview.py preview-den --stage pr-1234 --ref <pushed-sha>
```

For `preview-desktop`, the helper updates both Den web and the desktop renderer.
It preserves the Den database, accounts, Electron process and profile. Desktop
renderer updates use the existing Vite hot reload; reload the viewer/app if
needed. Verify the changed screen before claiming the update is visible.

The update helper rejects published release previews. Stop that exact stage and
launch a new stage/version instead; changing source cannot change published
desktop bytes.

The helper deliberately does not restart Den API, migrate data, or restart
Electron main/preload. For those changes, create a new stage on the new ref and
explain that it is a fresh preview. Do not silently reset a working preview.

## Reset, lifetime and stop

“Start over” means stop this exact world/stage, then repeat its launch command.
This deletes that preview's data. For a comparison, use another stage instead.

```sh
pnpm world down preview-den --stage pr-1234
```

The default lifetime is two hours from readiness, **not an idle timer**. Use
`--lifetime 0` only when the user asks to keep it until explicitly stopped;
otherwise accept 1–1440 minutes. The world process owns orderly teardown on
expiry or `down`; preview provisioning disables Daytona's separate idle timer
for both the Den and desktop sandboxes. An abruptly killed driver cannot run
that cleanup. Use only the exact `denSandbox` and `desktopSandbox` IDs recorded
in the owner-only outputs to inspect or remove leftovers; never delete by broad
name patterns.

`world up` compares recipe and invocation identity before adopting a live stage.
Script arguments, placement, and explicitly selected environment values must
match. Still inspect recorded scenario, Den ref, release version, distribution,
and digest: implicit preset defaults such as a moving remote dev ref are not a
request to update an existing world. Use a new stage or explicitly down/reset;
never treat adoption as an update.

Report the preview link, tested ref/scenario, expiry, and any actual limitation.
Keep infrastructure IDs and startup logs out of the user-facing walkthrough.
