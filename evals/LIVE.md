# Nightly live journeys

`pnpm evals:live` runs the `live` Vitest project against an already deployed Den.
It launches fresh local Chrome profiles and drives real clicks, typing, and
navigation through the existing CDP/testkit channels. It never provisions or
replaces the attached Den. No mocked auth, mail, Stripe, or subscription activation.
Every filename and test title contains `.live`.

The workflow `Nightly Live Evals` runs daily at **07:23 UTC** and supports manual
`workflow_dispatch`. GitHub enables schedules only once the workflow reaches the
repository's default branch. Live tests are excluded from normal PR/E2E suite
selection unless explicitly named. Runs are serialized, with no retries, to avoid
duplicate production mutations. Missing credentials, zero tests, skipped tests,
failed assertions, and cleanup errors all fail the nightly command.

## Coverage

| Journey | Observable witnesses |
| --- | --- |
| Public login | Email-first form renders; no authenticated controls |
| Protected routes | Dashboard, Members, Models return signed-out visitors to login |
| Signup | Real UI submission, delivered OTP, verification gate, authenticated account |
| Account access | Wrong password rejected, valid login, reload persistence, logout and route guard |
| Password recovery | Delivered first-party link, new password works, old password rejected |
| Dashboard navigation | Command palette opens Members/Connectors; route survives reload |
| Invitations | Existing live spec: two invitations, actual email delivery, exact members, exclusion of a never-invited address, organization deletion |
| Checkout cancellation | Models Subscribe opens Stripe; Back returns without subscription/entitlement |
| Subscription activation | Owned 100% forever coupon, zero total before submit, completed subscription and zero invoice, Den entitlement and subscribed UI after reload |

## Configuration

Set these **GitHub Actions secrets** before enabling the nightly workflow:

- `AGENTMAIL_API_KEY`: creates disposable inboxes and reads verification/reset/invite mail.
- `OPENWORK_EVAL_LIVE_STRIPE_SECRET_KEY`: matches the Stripe account/mode used by
  the target Den; needs customers, Checkout sessions, coupons, promotion codes,
  subscriptions, and invoice read access plus creation/cleanup permissions.

Optional repository variables `OPENWORK_EVAL_LIVE_DEN_API_URL` and
`OPENWORK_EVAL_LIVE_DEN_WEB_URL` override the production defaults
`https://api.openworklabs.com` and `https://app.openworklabs.com`. Use HTTPS origins.
The target must support email signup, organization creation and Models billing.
The runner image supplies Chrome; `CHROME_BIN` can select another installation.

For a local run, inject secrets through your secret manager (never command-line
arguments) and set the two URL variables plus `OPENWORK_EVAL_LIVE=1`:

```sh
pnpm install --frozen-lockfile --filter @openwork/world... --ignore-scripts
pnpm --dir evals install --frozen-lockfile
infisical run --silent -- pnpm evals:live
```

To inspect one journey, use `pnpm --dir evals exec vitest run --project live
specs/den-account.live.e2e.test.ts` with the same environment and
`OPENWORK_EVAL_E2E_TESTS=1`. Unlike the nightly wrapper, direct Vitest invocation
reports missing requirements as skips; that is **Incomplete**, never passing proof.

## Payment and cleanup contract

Checkout completion creates a one-redemption, one-hour coupon with a permanent
100% discount. The browser enters its promotion code into the real checkout.
Before submitting, the Stripe witness requires an owned discount and exact zero
total. It never enters a real card. If the target's Checkout still requires a card
at zero total, this journey fails and needs a compatible zero-payment checkout
configuration; a coupon alone does not guarantee card-free subscription signup.
This is a zero-cost subscription lifecycle test, not proof of a real card charge.
Stripe REST witnesses pin the same API version as Den (`2026-04-22.dahlia`).

Cleanup checks the unique mailbox and organization metadata before touching any
Stripe customer. It expires open sessions, cancels owned subscriptions without
proration/invoicing, deletes owned customers, disables promotion codes, deletes
coupons, then deletes the owned Den organization and mailbox. Cleanup also runs
after an assertion failure and reports failures. Checkout records/invoices remain
in Stripe's history. Process termination can interrupt cleanup; use the logged
`openwork-live-…` run identifier to investigate residue, never delete by a broad
name prefix alone. Coupons expire after an hour and remain 100% off forever for
an already created subscription, even if cancellation is interrupted.

Den does not expose self-service account deletion, so a full run currently retains
up to seven uniquely named test accounts per night. The existing invitation test
uses at most two inboxes; other journeys use one at a time. No customer accounts
or organization data are reused. A failed run may retain its owned organization
or Stripe objects and must be investigated.

Results: `evals/results/live/results.json`, `junit.xml`, and the job summary.
The workflow uploads reports for 14 days. Full ambient CDP evidence stays in
`evals/results/test-runs/` locally; audit it before publishing because email reset
links and temporary checkout URLs can appear in navigation traces.
