# Self-serve plans and add-ons

Den keeps organization billing in Stripe and mirrors paid access into organization metadata. The existing `seat` subscription slot holds either the legacy seat plan, Team, or Enterprise; SSO uses its own subscription slot. AI inference and standalone OpenWork Web retain their existing subscriptions.

## Prices and deployment

Run the database migration before deploying the API. In Stripe, create active monthly, per-unit, licensed USD prices (no quantity transform):

| Environment variable | Amount | Quantity |
| --- | --- | --- |
| `STRIPE_TEAM_PRICE_ID` | $10 | All non-removed organization members, including invitations; minimum 1 |
| `STRIPE_ENTERPRISE_PRICE_ID` | $40 | All non-removed organization members, including invitations; minimum 1 |
| `STRIPE_SSO_PRICE_ID` | $300 | 1 per organization |

These are new prices. Do not repoint `STRIPE_SEAT_PRICE_ID` or migrate existing subscriptions implicitly. Existing legacy seat billing retains its first-five-free calculation. Team purchases are limited to 100 users; larger organizations choose Enterprise.

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `DEN_PLAN_GATING_ENABLED=true` on the hosted deployment. Enable Stripe Tax and configure the registrations required for the business. Checkout collects a billing address and calculates tax. Configure the ordinary billing portal for payment methods, invoices, and cancellation; leave generic plan changes disabled there.

Create a separate Stripe portal configuration supporting Team and Enterprise prices, with subscription price updates, payment confirmation, and the desired proration policy. Set its ID as `STRIPE_PLAN_PORTAL_CONFIGURATION_ID`. Upgrades and downgrades use Stripe's hosted confirmation screen and update the existing subscription. Missing configuration fails closed instead of creating a second base subscription.

Keep the webhook subscribed to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Existing signature verification remains mandatory. The handlers retrieve the current subscription and its latest invoice; event order does not decide access.

## Access and lifecycle

Only configured prices grant paid features, and only with an active/trialing subscription and a paid latest invoice. Enterprise grants the existing Enterprise entitlements and included OpenWork Web access. Team + SSO grants SSO, including enforced SSO, without granting desktop version controls, policies, or analytics. Failed payments and ended subscriptions remove paid access. Cancellation scheduled for period end keeps access until the subscription ends.

Manual and grandfathered organization agreements are preserved. The paid metadata fields are server-owned, and checkout accepts only a product identifier. Owner/super-admin permission is required. Return-session sync verifies the organization. A second checkout reuses the pending session; an ongoing subscription leads to management/plan-change flow rather than a duplicate purchase.

SSO is billed separately from Team. Cancel it separately in Manage billing. Before upgrading Team + SSO to Enterprise, cancel SSO and allow its paid period to end, avoiding overlapping SSO charges. Existing standalone OpenWork Web subscriptions should likewise be canceled before starting Enterprise; the API blocks overlapping purchases. More add-ons can extend the server catalog, subscription types, entitlement mapping, and migration using the same flow; no unpriced add-ons are offered.

This implementation is for hosted Den. Self-hosted deployments still require an appropriate manual license/plan assignment; automated self-hosted license issuance is not included.

## Verification

`OPENWORK_EVAL_MYSQL_URL=mysql://root:password@127.0.0.1:3306 pnpm evals:pr specs/self-serve-billing.test.ts` boots a real isolated Den with a local Stripe HTTP simulator, signs webhook payloads, and asserts checkout, price/quantity validation, payment state, organization isolation, Enterprise features, and SSO cancellation. Requires local MySQL/Redis and built workspace dependencies. The ordinary CI unit lane skips this service-dependent journey when `OPENWORK_EVAL_MYSQL_URL` is absent; publish the explicit journey run as PR evidence. The simulator is available only with `OPENWORK_DEV_MODE=1` and a loopback `OPENWORK_TEST_STRIPE_PORT`; production uses Stripe's normal endpoint.

Before live rollout, exercise a purchase, plan change, renewal, and cancellation using Stripe test mode with the actual price IDs, Tax, and portal configuration. The local simulator proves application behavior; it does not configure the production Stripe account.
