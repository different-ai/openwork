# Verification

## Browser regression

`pnpm evals:e2e workbot-profile-computers --local` — **Passed**, 1 test, 0 failures, 0 skips. Placement: `local (--local)`, headless Chrome, actual Workbot Vite client and host response parsing. Synthetic sign-in, inventory and computer-provider API answers; no live Den, runner, external task or VM provisioning is claimed.

The proof covers:

- Flag off: standalone Devices and the original five-tab profile.
- Flag on: six tabs, Computers selected, one existing inventory GET and no standalone duplicate.
- Arrow keys, Home/End, focused selection and Escape.
- Desktop 1440×960 and phones 390×844 / 320×844; all six touch targets at least 44×44px, no horizontal page overflow.
- Existing Open action closes the sheet and navigates to the existing computer view.
- Existing empty and failed/retry list states.
- Devices disabled: no Computers tab and no inventory read.
- Rollback: standalone Devices and `/devices` still work, inventory unchanged.

The identical proof and world were copied into a clean detached control at `732f1bfaad3a59add6d3f92e542944e7f4777e5c` (the branch's `origin/dev` base). The same command fails at the first attempt to select Computers: only Tasks, Files, Apps, Schedules and Identity exist. This confirms the test distinguishes the change from its base.

## Other checks

- `pnpm --filter @openwork-ee/workbot test:devices` — passed, 12 server tests + 5 UI tests, no skips. Includes rollout dependencies, older-server default-off behavior, standalone-entry fallback, inventory states and existing access/reporting rules.
- `pnpm --filter @openwork/features test` — passed, 12 tests, no skips.
- `pnpm --filter @openwork-ee/workbot-ui typecheck` — passed.
- `pnpm --filter @openwork-ee/workbot typecheck` — passed.
- `pnpm --filter @openwork-ee/workbot build` — passed (client and server bundles).
- `pnpm --filter @openwork-ee/den-api typecheck` — passed.
- `pnpm --dir evals lint:specs` — passed.
- `pnpm check:node-source-imports` — passed.
- `pnpm --dir evals typecheck` — blocked by `evals/proofs/local-models-policy.proof.test.ts:70`: TS2353, `timeoutMs` is not a `ClickOptions` property. The exact command fails with the identical single error in the clean detached base control. No unrelated fix was included.

## Visual review

The captured desktop, 390px and 320px screenshots were reviewed at actual size. `pnpm --dir evals design:review -- --test-run latest` reports one medium `layout.overlap` note at 320px. This is a layout-witness false positive: it records the same truncated computer-name text twice at the exact same x/y, once with its unclipped text width and once with its clipped width. The type/status text is on subsequent lines, not overprinted; the screenshot confirms there is no visual overlap. The existing list's truncation and row styling were deliberately preserved rather than redesigned to silence that duplicate measurement.

The local runtime is Node 24.15.0, below the repository's requested 24.22.1 minimum; pnpm emits engine warnings. Tests and builds above still complete. Phone checks emulate narrow Chrome viewports, not physical iOS/Android devices.

No merge, deployment, production flag mutation or production data access was performed. The new registry feature is default-off on cloud and self-hosted installations.
