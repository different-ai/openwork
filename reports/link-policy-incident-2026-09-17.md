# Trusted primary link routing incident — 2026-09-17

## Status

Product verification passed on signed runtime-changing head `45d6e1ee0a36f31faf4838df0e8385d8fde5faac`. Pull request [#5123](https://github.com/different-ai/openwork/pull/5123) is open with exact-head test evidence and inspected screenshots published. At the final audit, every reported automated check had completed without failure; GitHub exposed no Warden check, review, comment, or finding to inspect, so Warden is recorded as not reported rather than passed. The pull request remains unmerged and `REVIEW_REQUIRED` pending human approval.

## User-visible issue

A trusted primary click on an HTTPS link was always sent to OpenWork's built-in browser path. The desktop policy bridge returned only success or failure, so the browser panel could not distinguish a definitively unmanaged desktop from a managed one. Policy failures were reduced to a generic error without a recovery action.

An isolated clean-profile baseline confirmed that a signed-out-looking desktop opened the link in the built-in browser with no native modal. That observation did not reproduce a retained organization policy and is not evidence that every signed-out desktop is unmanaged.

## Root cause

- `apps/server/src/managed-desktop-policy.ts` already distinguished no identity plus no retained policy from retained or active organization policy, but `assert()` discarded that distinction.
- `apps/server/src/server.ts` returned only `{ allowed: true }` from `/managed-policy/evaluate`.
- `apps/desktop/electron/main.mjs` discarded safe policy error messages and exposed no authority state.
- `apps/desktop/electron/browser-panel.mjs` hard-coded trusted primary clicks to `open-builtin`.

The existing identity-generation fence remains authoritative. A policy read that races with identity installation still returns `policy_identity_changed`, and no cached allow decision is introduced.

## Repair

- Policy evaluation now returns `authority: "managed" | "unmanaged"` after the authoritative server check.
- Only an affirmative unmanaged decision routes a trusted primary HTTPS link to the OS default-browser boundary.
- Managed decisions retain built-in routing, and explicit **Open in OpenWork** behavior is unchanged.
- Retained-policy sign-out, Den outage, identity change, malformed responses, and unavailable local policy service remain fail-closed.
- Retained-policy sign-out shows **Sign in to verify your organization’s link policy** with **Sign in / Cancel**. Sign in uses the existing native settings bridge to open Cloud Account; it never asks for credentials in the dialog.
- A genuine policy denial shows **This link is blocked by your organization’s policy** with only **Cancel**.
- A service or readiness failure shows **OpenWork couldn’t reach its link-policy service** with **Retry / Cancel**. Retry performs exactly one fresh evaluation; a second failure offers only Cancel.
- Native-dialog labels follow the desktop's active application locale and fall back to English for unknown locale input. Locale input changes text only and cannot affect policy authority.
- Sender, source-frame, navigation-lifetime, and request-boundary policy checks remain in place.

## Verification so far

| Claim | Evidence | Result |
|---|---|---|
| Unmanaged/managed authority is returned by the real local endpoint | `apps/server/src/effective-permissions.e2e.test.ts` | Passed |
| Retained policy after sign-out stays fail-closed | `apps/server/src/managed-desktop-policy.test.ts` | Passed |
| Identity installation during persisted-policy read is fenced | Existing generation-race test, updated for the authority result | Passed |
| Unmanaged primary HTTPS routing, distinct sign-in/denial/outage states, localized labels, zero-launch failures, bounded Retry, managed recovery, and Cloud Account handoff | `apps/desktop/electron/browser-panel.test.mjs` (99 tests) | Passed |
| Exact trusted transcript click emits exactly `https://example.com/`, opens no built-in tab, and leaves the transcript interactive | `evals/specs/link-policy-primary-routing.e2e.test.ts`, isolated local Electron lane | Passed |
| Desktop Electron typecheck | `pnpm --filter @openwork/desktop typecheck:electron` | Passed |
| Renderer typecheck | `pnpm --filter @openwork/app typecheck` | Passed |
| Server typecheck and focused policy tests | Focused `@openwork/server` commands | Passed |
| Exact-ref Daytona product run | `OPENWORK_EVAL_REF=45d6e1ee0a36f31faf4838df0e8385d8fde5faac`; one trusted-click journey | Passed |
| Exact-ref Daytona final-head run | Published `test-evidence` PR comment; its SHA and sandbox ref both identify the final report-only head | Passed |
| Retained-policy sign-out dialog and Cloud Account handoff | Isolated managed Electron; native **Sign in** selected, then `#/workspace/<workspace-id>/settings/cloud-account` asserted | Passed |
| Genuine organization denial with no bypass | Isolated managed Electron against a restrictive Den policy | Passed |
| Den outage and bounded fresh Retry | Isolated managed Electron; first dialog had **Retry / Cancel**, second had only **Cancel** | Passed |
| Affirmatively unmanaged external open | Fresh isolated Electron and OS-default Chromium shown side by side at `https://example.com/` | Passed |

The first Daytona diagnostic was rejected as evidence because the uncommitted product change was not present in its `dev` checkout. A later post-commit diagnostic was also rejected because it omitted `OPENWORK_EVAL_REF` and explicitly verified `dev` at `030be3e313aad4d73a6dbfe54a842284359c75fc`. That diagnostic red was published with its cause stated; the sticky evidence was then updated with the passing exact-head run after pinning the signed commit.

## Inspected screenshots

- [Retained-policy sign-in dialog](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr-evidence/link-policy-45d6e1ee/link-policy-sign-in-JbD6HhH16KS4pqm13wNM7YGtQmoiUw.png)
- [Genuine organization-policy denial](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr-evidence/link-policy-45d6e1ee/link-policy-denial-clean-spK6gQXOHCFafVc71RAgDsmAEwtDmk.png)
- [Link-policy service outage with Retry](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr-evidence/link-policy-45d6e1ee/link-policy-outage-tPig3JkIt7bL62YVJzc10FSCCsg7I4.png)
- [Affirmatively unmanaged default-browser handoff](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr-evidence/link-policy-45d6e1ee/link-policy-unmanaged-external-UgqizwyMh3Vvgayqi3g7zWf9YrssC7.png)

All four frames were captured from isolated real Electron at the pushed product head, inspected for healthy dimensions, meaningful pixels, clipping, overlap, unrelated overlays, and personal information, then uploaded to public evidence storage. A discarded diagnostic frame that exposed an unconsumed fixture handoff code was deleted and was not published.

## Safety properties not changed

- No managed-policy bypass.
- No renderer-derived signed-out permission.
- No offline allow-cache.
- No catch-to-external fallback.
- No change to explicit link context-menu choices.
- No use of a shared desktop profile, authentication state, or protocol registration.

## Final gate audit

| Gate | Final observed result |
|---|---|
| Exact-head test evidence | Passed and published on the pull request; the evidence SHA matched its Daytona sandbox ref |
| Build and core checks | Passed, including `openwork-tests-build`, `openwork-tests-core`, `openwork-tests-required`, and `workflow-authoring`; unrelated jobs classified out by the workflow were skipped |
| CodeQL | Passed for actions, JavaScript/TypeScript, and Python; the aggregate CodeQL check passed |
| Repository guards | `i18n-audit`, `guard-legacy-eval-flows`, validation, and change classification passed |
| Vercel Agent Review | Passed |
| Warden | Not reported: no Warden check, pull-request review, comment, or finding was attached to the final head; absence is not represented as approval |
| Human review | Pending: GitHub reports `REVIEW_REQUIRED`, so the pull request remains unmerged |

No queued, in-progress, or failed automated check remained at the final audit. The only observed merge blocker was the required human review.
