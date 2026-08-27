# OpenWork Web billing review frames

These screenshots supplement the executable proof for the OpenWork Web billing pull request. They were recaptured from an isolated multi-org Den containing 17 joined members and 3 pending invitations, with the dedicated Web Stripe Price configured. To keep the visual frames deterministic and avoid initiating a payment during recapture, the post-purchase frames use local subscription rows shaped like the normalized Stripe webhook records covered by the executable proof. The Web offer is deployment-wide in this configuration; it no longer depends on mutable organization Cloud metadata.

The customer-facing copy leads with members × unit price (`17 members × $50.00`) and keeps the monthly total secondary, per review.

- `01-purchase-boundary.jpg` shows the purchase page before any subscription: the quantity definition, `17 members × $50.00` with the secondary monthly total, and the single purchase action.
- `02-active-billing.jpg` shows the active Billing card: plan, unit price, members billed, expected monthly total, subscription and payment status, and management actions.
- `03-payment-failed-lock.jpg` shows that a subscription with a failed payment stays locked and routes the administrator to Billing instead of presenting a duplicate purchase action. This frame was refreshed on 2026-08-27 after the stale Checkout replay regression was fixed and verified.
- `04-cancellation-scheduled.jpg` shows scheduled cancellation on Billing: access continues through the current period and the subscription can be reactivated before then.

These rendered frames are supplementary and do not decide pass/fail. The pull request's `@openwork/testkit` spec and focused suites cover multi-org plus Stripe configuration availability, self-deploy concealment, pricing, authoritative quantity, organization association, webhook idempotency, Checkout confirmation, payment failure and recovery, cancellation, terminal revocation, reactivation, and duplicate-subscription prevention.

Live-mode Stripe resources and production configuration remain explicit pre-launch gates.
