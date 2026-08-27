# OpenWork Web billing review frames

These screenshots supplement the executable proof for the OpenWork Web billing pull request. They were captured from an isolated local Den with the existing Cloud capability enabled for a demo organization containing 17 joined members and 3 pending invitations, after the test-mode Stripe Product/Price was configured and a hosted test-mode Checkout had been completed against this stack.

The customer-facing copy leads with members × unit price (`17 members × $50.00`) and keeps the monthly total secondary, per review.

- `01-purchase-boundary.jpg` shows the purchase page before any subscription: the quantity definition, `17 members × $50.00` with the secondary monthly total, and the single purchase action.
- `02-active-billing.jpg` shows the active Billing card: plan, unit price, members billed, expected monthly total, subscription and payment status, and management actions.
- `03-payment-failed-lock.jpg` shows that a subscription with a failed payment stays locked and routes the administrator to Billing instead of presenting a duplicate purchase action. This frame was refreshed on 2026-08-27 after the stale Checkout replay regression was fixed and verified.
- `04-cancellation-scheduled.jpg` shows scheduled cancellation on Billing: access continues through the current period and the subscription can be reactivated before then.

These rendered frames are supplementary and do not decide pass/fail. The pull request's `@openwork/testkit` spec and focused suites cover pricing, authoritative quantity, organization association, webhook idempotency, Checkout confirmation, payment failure and recovery, cancellation, terminal revocation, reactivation, and duplicate-subscription prevention.

Live-mode Stripe resources, production configuration, and the launch decision remain explicit pre-launch gates.
