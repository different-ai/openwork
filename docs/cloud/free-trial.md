# Optional seven-day cloud trial

Workspace owners and admins can start a free trial from setup or the OpenWork Web page. Starting requires no card and creates no Stripe subscription. Ordinary members can see its status and use cloud access after an admin starts it.

The trial covers OpenWork Web/cloud runtime access. It does not change model-provider credentials, model pricing, inference credits, or team-seat billing. Paid conversion always requires the existing explicit checkout.

## Safe rollout

`DEN_OPENWORK_CLOUD_TRIAL_ENABLED` defaults to `false`. While disabled, new workspaces receive `ineligible` from the trial endpoint and cannot start a trial. Existing trials retain their original entitlement, status, and notifications if the flag is turned off later; disabling it prevents new starts only.

1. Apply migration `0092_cloud_week_trial` and deploy Den with the trial flag disabled.
2. Release the desktop client that accepts `accessSource: "trial"` in the existing billing response. Earlier desktop releases reject that value; deploying the server alone does not update those clients.
3. Complete the compatible desktop rollout before explicitly enabling `DEN_OPENWORK_CLOUD_TRIAL_ENABLED=true` on Den. OpenWork Web must also be enabled. Do not enable trials while supported desktop versions still reject the response.

The API continues to report trial access truthfully; it does not disguise trials as subscriptions or complimentary grants. A later flag rollback does not repair old desktop clients for already-active trials, so compatibility must be established before the first trial starts.

## Entitlement and persistence

Apply migration `0092_cloud_week_trial` before deploying. The durable row has unique workspace and starting-account keys. Concurrent starts and retries return the original dates; creating another workspace does not give the same starting account another week. Existing subscription customers and complimentary grants are not eligible for a new trial. Trial records are deliberately retained independently of workspace deletion to preserve one-time eligibility.

`GET /v1/billing/web-trial` returns the current member's eligibility or their workspace's trial status. `POST /v1/billing/web-trial` requires admin access and a fresh privileged session. Neither endpoint accepts dates or an organization ID from its body; normal organization-scoping middleware applies.

The existing runtime entitlement resolver checks the server clock on each new request. Once the trial expires, new cloud work is denied even with an existing session. Already running work is not forcibly canceled; the existing idle lifecycle still applies. Expiry does not delete saved work. Subscription and complimentary access take precedence over a trial and suppress trial-expiry messaging.

## Notifications

The normal API server runs a durable reminder poller. It sends an email during the final 24 hours and another after expiry, to the starting member or the current owner if that member has been removed. The email names the workspace and includes its end time. In-app notices also show the end date and the explicit paid-plan action.

`OPENWORK_CLOUD_TRIAL_POLL_MS` defaults to 60000 milliseconds (minimum 1000). Reminder markers and ten-minute claim leases live in MySQL. Failed sends retry after the lease expires; independent server processes cannot normally deliver the same phase concurrently. A crash after delivery but before committing its marker can duplicate an email. Email delivery never controls entitlement. In dev mode the existing outbox records `cloudTrial` emails without a live provider.

## Verification

- `pnpm evals:pr specs/remote-session-first-use.test.ts`: concurrent starts, permissions, real cloud-runtime witness, expiry, reminders, and explicit paid access.
- `pnpm evals:e2e cloud-week-trial`: optional setup, start and reload, model-pricing explanation, expiry and explicit paid-plan navigation.

This change targets the existing onboarding screen independently of the broader signup redesign. When combining with that redesign, retain `CloudTrialCard` as an optional step/card in its final setup screen.
