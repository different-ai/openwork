# Remembered sign-in and helper tasks GA; early update window removed

## Scope

Implemented on `feat/ga-signin-helper-remove-update`, based on `origin/dev`
`2a89b7a233`, using GPT-6.1 Sol on the Mac Studio in an isolated worktree.
The originating checkout's work was not stashed, reset or modified.

- **GA:** `lastUsedSignIn`. Authentication always remembers successful password,
  Google and GitHub sign-ins; the web panel reads the cookie without fetching
  feature state. SSO clears the hint. Existing SSO, invitation, configured-provider
  and prefilled-email rules remain.
- **GA:** `remoteSessionHelperView`, the exact flag for “Desktop: open a task on
  another computer like a helper.” Retained main-pane opening, Enter follow-up,
  Stop, Esc/prior-chat draft restoration, last-step row, Agents list and sidebar
  nesting. `remoteSessionThreadView` was already GA on the base; no legitimate
  access, runner capability or conversation prerequisite was removed.
- **Removed, not GA:** `desktopUpdateDownloadWindow`. Restored the pre-existing
  updater path from before introduction commit `638386a4bd`: titlebar restart
  only when ready, existing confirmation/install behavior, normal Settings
  progress, newest-allowed-build refresh and organization install policy checks.
  Removed the early restart orchestration, download-progress dialog, cancellation
  callback and experiment-only copy/documentation.

All three entries are removed from the active registry. Retired input keys are
accepted and ignored. Old-client API compatibility values are fixed true for
both GA behaviors and fixed false for the deleted experiment; these are not
configurable flags. `pnpm features:sync` regenerated Helm. No generated API
contracts are included in the changes.

## Verification

Final targeted checks used Node **24.22.1**, pnpm **11.4.0**, Bun **1.3.10**.

| Check | Result |
| --- | --- |
| `pnpm features:sync` / `pnpm features:check` | Passed |
| `pnpm --filter @openwork/features test` | 26 passed, no failures/skips |
| Den API `feature-response` and `last-sign-in-method` unit tests | 9 passed, no failures/skips |
| Den API `permission-feature-cache` unit tests | 5 passed, no failures/skips |
| Den web `last-sign-in` unit tests | 3 passed, no failures/skips |
| Updater `desktop-update-button`, `electron-updater-install-policy`, `electron-updater-check-now` (separate processes) | 54 passed, no failures/skips |
| Helper sentence row, composer tracker/follow-up, route and run-line unit tests (separate processes) | 21 passed, no failures/skips |
| `pnpm sdk:build` | Passed; generated contracts remain ignored |
| App, Den API, Den web and feature-package typechecks | Passed |
| `pnpm --dir evals typecheck` | 480 source files passed |
| `pnpm --dir evals lint:specs` | 126 files, zero errors |
| Targeted Den web ESLint; `git diff --check` | Passed |

**118 targeted unit/component tests passed.** Bun DOM/module-mock suites are run
one file per process: combining the new updater component mock with hook suites
causes module-mock contamination (5 install-policy failures in the combined
command); each suite passes independently, matching the repo's one-test-at-a-time
verification guidance.

### Real-browser proofs

Run serially from this worktree with:

```sh
DATABASE_REDIS_URL=redis://127.0.0.1:16389 pnpm evals:e2e remote-session-helper-view --local
DATABASE_REDIS_URL=redis://127.0.0.1:16389 pnpm evals:e2e remembered-sign-in-ga --local
```

Both commands exited **0**, each **1 passed / 0 failed / 0 skipped**. Placement
was `local (--local)` against this working tree, not a remote `dev` build.
Each run cold-booted Den without a reuse override.

- Helper proof: seven observable steps, seven screenshots. Default organization
  with no helper rollout activation; verifies last step and sidebar, Agents list,
  main pane and focus, Enter reaching the registered runner, Esc/draft continuity,
  reopening with unsent follow-up, and exactly one Stop reaching the runner.
- Sign-in proof: six observable steps, six screenshots. Real UI password sign-in
  writes the readable, long-lived method cookie; sign-out and reload show Last
  used and password immediately; Single sign-on returns to email-first; a second
  browser does not inherit the hint. No injected browser cookies or feature enable.

Local evidence (ignored runtime outputs, not committed screenshots):

- `evals/results/test-runs/2026-10-31T06-01-58-015Z-14623-a-member-in-a-default-organization-follows-a-task-on-their-other-computer-from-t/index.html`
- `evals/results/test-runs/2026-10-31T06-04-23-478Z-19520-a-returning-password-member-skips-the-email-only-step-without-enabling-a-feature/index.html`

The proof was updated to hover before Open (the existing action is hover-only)
and expand the existing collapsed transcript steps before inspecting them.
A test-only immediate-navigation/reload CDP race was removed from the new sign-in
proof. No product workaround was added to satisfy these checks.

### Counterfactual controls

Copied the final proofs/worlds into a disposable clean `origin/dev` worktree at
`2a89b7a233`, with equivalent Node, dependencies and local database services:

| Same check on base | Expected failure |
| --- | --- |
| Helper browser proof | 0 passed / 1 failed: row stayed `Record the demo videos · Studio computerWorking 59s`, without last step |
| Remembered sign-in browser proof | 0 passed / 1 failed: successful UI password sign-in produced no remembered-method cookie (`null`) |
| New updater button component test | 6 passed / 2 failed: premature restart action present in `available` and `downloading` |

Thus the checks distinguish this implementation from the default-off base.

## Limits and pre-deploy checks

Targeted implementation verification passed. Release/deployment verification is
**Incomplete**: no packaged native update/download/install smoke was performed,
no actual Google/GitHub OAuth or live SSO round-trip was attempted, and no
production rollout impact census was possible with the tools available in this
session. Cookie/SSO edge rules have unit coverage; browser coverage uses password.
No merge, deployment, production writes or rollout-setting changes were made.

Docker's pinned Redis image failed with a containerd storage I/O error. Tests
instead used an owned disposable Homebrew MySQL data directory and a separate
Redis on port 16389, leaving existing services alone. The default shell's Node
25 was replaced only in command PATH with downloaded, SHA-256-verified Node
24.22.1; no global Node configuration was changed.

Before a later deployment, use the authorized read-only admin database capability
to inspect existing state for these keys and combine it with deployment/operator
locks (and the current resolver's precedence). No rows need to be deleted; the
code ignores them. Example state inventory, with results kept private:

```sql
SELECT feature_key, enabled, killed FROM feature_rollout
WHERE feature_key IN ('lastUsedSignIn', 'remoteSessionHelperView', 'desktopUpdateDownloadWindow');
SELECT organization_id, feature_key, enabled FROM organization_feature
WHERE feature_key IN ('lastUsedSignIn', 'remoteSessionHelperView', 'desktopUpdateDownloadWindow');
SELECT member_id, feature_key, enabled FROM member_feature
WHERE feature_key IN ('lastUsedSignIn', 'remoteSessionHelperView', 'desktopUpdateDownloadWindow');
```

Previously disabled GA behavior becomes available; previously enabled early
update behavior disappears. No authorization or billing entitlement changes.
API-first upgrades preserve the intended behavior for older supported clients.
Rollback requires a code revert, not re-enabling retired flags.

## Changed files

In addition to this report:

```text
apps/app/src/components/chat/remote-thread-run-line.tsx
apps/app/src/i18n/locales/en.ts
apps/app/src/react-app/domains/session/chat/session-page.tsx
apps/app/src/react-app/domains/session/remote-threads/remote-session-surface.tsx
apps/app/src/react-app/domains/session/remote-threads/remote-thread-store.ts
apps/app/src/react-app/domains/session/remote-threads/remote-tracker-row.tsx
apps/app/src/react-app/domains/session/remote-threads/use-remote-session-subagents-feature.ts (deleted)
apps/app/src/react-app/domains/session/sidebar/remote-task-sidebar-rows.tsx
apps/app/src/react-app/domains/session/status/use-desktop-feature.ts
apps/app/src/react-app/domains/session/surface/composer/composer-subagent-tracker.tsx
apps/app/src/react-app/domains/session/surface/session-surface.tsx
apps/app/src/react-app/domains/settings/pages/updates-view.tsx
apps/app/src/react-app/domains/settings/state/desktop-updater-provider.tsx
apps/app/src/react-app/domains/settings/state/electron-updater-state.ts
apps/app/src/react-app/shell/session-route.tsx
apps/app/tests/composer-remote-follow-up.test.tsx
apps/app/tests/composer-subagent-tracker-remote.test.tsx
apps/app/tests/desktop-update-button.test.tsx (new)
apps/app/tests/electron-updater-install-policy.test.ts
apps/app/tests/remote-thread-sentence-row.test.tsx
docs/feature-ga-october-2026.md
docs/features/desktop-update-download-window/README.md (deleted)
docs/features/last-used-sign-in/README.md
docs/features/remote-session-helper-view/README.md
docs/session-offloading-architecture.md
ee/apps/den-api/src/auth.ts
ee/apps/den-api/src/feature-response.ts
ee/apps/den-api/src/last-sign-in-method.ts
ee/apps/den-api/test/feature-response.test.ts
ee/apps/den-api/test/last-sign-in-method.test.ts
ee/apps/den-api/test/permission-feature-cache.test.ts
ee/apps/den-web/app/(den)/_components/auth-panel.tsx
ee/apps/den-web/app/(den)/_lib/last-sign-in.test.ts
ee/apps/den-web/app/(den)/_lib/last-sign-in.ts
evals/proofs/remembered-sign-in-ga.proof.test.ts (new)
evals/proofs/remote-session-helper-view.proof.test.ts
evals/worlds/remembered-sign-in-ga.ts (new)
evals/worlds/remote-session-helper-view.ts
packages/features/src/registry.ts
packages/features/src/resolve.test.ts
packages/features/src/resolve.ts
packaging/helm/openwork-ee/values.schema.json
packaging/helm/openwork-ee/values.yaml
```
