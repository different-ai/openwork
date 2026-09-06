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

## Start and open

Use a unique stage such as `pr-1234` to keep previews separate. First inspect
`pnpm world list` and `pnpm world outputs <world> --stage <stage> --json`.
An existing matching world should be reopened, not recreated. Compare its
recorded scenario and ref before adopting it. A stage is not a git ref.

Use reviewed repository code: previews execute that ref’s build scripts. Do not
load production credentials or attach shared secrets volumes. Push the intended
commit and use its full 40-character SHA so Daytona can fetch it. Both launch
and update reject mutable branch names. Then:

```sh
OPENWORK_EVAL_REF=<pushed-sha> infisical run --silent --env dev -- pnpm world up preview-den --stage pr-1234 --place daytona --detach --timeout 600000 -- --scenario fresh --lifetime 120
```

Substitute `preview-desktop` and the desired scenario as needed. The existing
Daytona snapshots handle dependencies. A cold build takes minutes; reopening a
ready world is quick. Never promise seconds for an unmeasured cold boot.

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
expiry or `down`. An abruptly killed driver cannot run its cleanup; inspect the
stage's resource ledger and use the existing world reaper for orphan recovery.
Do not delete sandboxes by broad name patterns.

Report the preview link, tested ref/scenario, expiry, and any actual limitation.
Keep infrastructure IDs and startup logs out of the user-facing walkthrough.
