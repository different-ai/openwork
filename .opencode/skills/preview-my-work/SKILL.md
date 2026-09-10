---
name: preview-my-work
description: Boot, reopen, update, or reset an isolated OpenWork PR preview inside Codex. Use Den in the in-app browser or the real Linux Electron app streamed through Daytona noVNC for hands-on testing.
---

# Preview my work

Use the repository's world lifecycle. These are disposable test environments,
not production or a user's installed desktop profile. Do not touch another
world or an existing test sandbox. Run from the requested worktree.

## Choose a preview

- `preview-den`: signup, team administration, onboarding, connectors, policies.
- `preview-desktop`: real Electron plus its own Den; workspaces, chat and native
  app interactions. This is Linux Electron, not a macOS/Windows parity check.

Choose `--scenario fresh` for signup/first use, `team` for an owner with Notion
and Linear available (individual accounts remain unconnected), `restricted`
for that team with the API's canonical restricted policy values, or `workspace`
for a signed-in desktop workspace without pre-added tools. Fresh desktop creates
its local workspace but does not sign into Den. No model credentials are seeded.
Do not describe these fixtures as capable of live model/provider requests.

Use `--scenario blank --release <x.y.z> --distribution <name>` to preview exact
published Linux x64 tarball bytes with a completely isolated, unseeded profile.
Supported distributions are `public`, `cloud`, and `enterprise`; other
platforms, architectures, package formats, prereleases, and mutable/latest
versions are not supported. The installer resolves the exact `v<x.y.z>` GitHub
release asset and verifies its API-published SHA-256 digest before extraction.

## Start and open

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
another. Release sandboxes do not mount shared secrets and do not run a source
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

`world up` adopts an already-running stage before it evaluates new script
arguments. Inspect its recorded scenario, Den ref, release version,
distribution, and digest first. If any requested value differs, use a new stage
or explicitly stop/reset the existing one; never treat adoption as an update.

Report the preview link, tested ref/scenario, expiry, and any actual limitation.
Keep infrastructure IDs and startup logs out of the user-facing walkthrough.
