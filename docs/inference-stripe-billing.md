# OpenWork Models Stripe Billing

## Test Mode Resources Created

- Stripe account: `acct_1TUzKI2Ytt5tm5rQ` (`OpenWork`)
- Product: `prod_UVuIUSone1SPMb` (`OpenWork Models`)
- Monthly price: `price_1TWsTW2Ytt5tm5rQTgrMhiP8`
- Price amount: `$10/user/month`
- Billing portal configuration: `bpc_1TWshm2Ytt5tm5rQvZX4VQ5P`
- Portal configuration is default in test mode.

## Production Setup Checklist

1. Create the same `OpenWork Models` product in Stripe live mode.
2. Create a recurring monthly licensed price at `$10/user/month`.
3. Configure the billing portal with customer email/name updates, payment method updates, invoice history, and subscription cancellation at period end.
4. Set Den API environment variables:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_INFERENCE_PRICE_ID`
   - `STRIPE_BILLING_SUCCESS_URL`
   - `STRIPE_BILLING_CANCEL_URL`
5. Configure a Stripe webhook endpoint to Den API `POST /v1/webhooks/stripe`.
6. Subscribe the webhook endpoint to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`

## Local Webhook Forwarding

Run Den locally, then start Stripe CLI forwarding:

```bash
pnpm run dev:web-local
stripe listen --forward-to localhost:8790/v1/webhooks/stripe
```

Copy the `whsec_...` value from Stripe CLI output into `ee/apps/den-api/.env.local` as `STRIPE_WEBHOOK_SECRET` and restart `pnpm run dev:web-local`.

## Behavior

- Checkout quantity is the active org member count when checkout is created.
- Checkout quantity is not adjustable in Stripe Checkout.
- Stripe customer and subscription metadata include:
  - `org_id`
  - `created_by_org_member_id`
  - `openwork_product=openwork_models`
  - `subscription_type=inference` on subscriptions
- `org_subscriptions` is a Stripe-driven local mirror used for entitlement checks.
- Adding or removing org members updates the Stripe subscription item quantity with `proration_behavior=always_invoice`.
- `invoice.payment_failed` immediately marks the local subscription as `expired` and disables inference, which revokes active inference keys.
- `customer.subscription.deleted` and expired subscription statuses also disable inference.
