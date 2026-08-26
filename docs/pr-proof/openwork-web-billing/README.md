# OpenWork Web billing review frames

These screenshots supplement the executable proof for the OpenWork Web billing pull request. They were captured from an isolated local Den database with the existing Cloud capability enabled for a demo organization containing 17 joined members and 3 pending invitations.

- `01-purchase-boundary.jpg` shows the pre-Checkout definition and math: pending invitations are excluded, 17 joined members are billed at $50 each, the expected total is $850/month, and access waits for Stripe confirmation.
- `02-active-billing.jpg` shows the active plan, unit price, billable quantity, monthly total, payment status, and renewal date.
- `03-payment-failed-lock.jpg` shows that an existing subscription with a failed payment stays locked and routes the administrator to Billing instead of presenting a duplicate Checkout action.
- `04-cancellation-scheduled.jpg` shows continued access through the current period, the access-end date, and the Stripe reactivation boundary.

These rendered frames are supplementary and do not decide pass/fail. The pull request's `@openwork/testkit` spec and focused suites cover pricing, authoritative quantity, organization association, webhook idempotency, Checkout confirmation, payment failure and recovery, cancellation, terminal revocation, reactivation, and duplicate-subscription prevention.

No live Stripe payment was submitted during this local pass. Test-mode Stripe Product/Price configuration, the hosted Checkout review, Billing Portal configuration, and the launch decision remain explicit pre-launch gates.
