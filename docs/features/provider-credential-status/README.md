# AI provider credential status

> **GA:** Available without a feature flag. The former rollout key is retired.
> Off/on screenshots below are historical comparisons, not current deployment options.

- Retired rollout key: `providerCredentialStatus`
- Deployments: cloud and self-hosted
- Status: generally available (no flag)
- Owner: `benjaminshafii`

AI Providers distinguishes a saved credential from one that has actually
answered a request. Catalog discovery, importing an organization provider,
and saving a key do not verify inference authentication.

| Evidence | State | Recovery |
| --- | --- | --- |
| No successful inference request | Not checked yet | Use the provider in a chat |
| Successful request | Ready to use | None |
| Inference 401 or recognized invalid/expired credential | Key not accepted | Replace key (personal), update environment credential (environment), contact your admin (organization) |

Existing policy locks, engine availability and cloud synchronization states
keep their precedence. Access-denied 403, rate limits, timeouts, cancellation,
network failures and Gateway member sign-in requirements are not upstream
credential rejections.

## Try it

Connect a provider, send a chat, then reopen
Settings > AI Providers. A newly saved key reads **Not checked yet**. A rejected
key offers recovery rather than claiming readiness. Replacing it clears the
old verdict; a later successful request earns **Ready to use**.

`evals/proofs/provider-credential-status.proof.test.ts` exercises this flow
with native OpenCode v2 and a loopback-only fault provider. No paid or real
provider keys are used, and the fault server records credential labels rather
than Authorization values.

### Saved but not verified

![AI Providers shows Not checked yet for a newly saved synthetic key](./unverified.png)

### Rejected by the provider

![AI Providers shows Key not accepted and Replace key after a real loopback 401](./rejected.png)

### Verified by a successful request

![AI Providers shows Ready to use only after the replacement key answers](./verified.png)

## Evidence and lifetime

Only outcomes and credential-change revisions are persisted locally, scoped
to workspace and runtime provider ID. No keys, request payloads, provider
response bodies or error text enter the health store. Rejection survives
navigation and reload when browser persistence is available; blocked or full
storage never interrupts chat. Durable assistant outcomes recover missed
lifecycle events, ordered by their completion time so reading an older chat
cannot overwrite a newer verdict. Saving a replacement or completing a new sign-in
clears the verdict across workspaces sharing the same credential store;
removal also clears it before an environment fallback is discovered. Remote
hosts keep separate credential revisions. A request already running at
replacement time cannot verify or reject the replacement: evidence uses the
engine's start time, not when the renderer first observes a busy run. A run
without a trustworthy start time remains unverified. Organization provider
version or organization-context changes also clear the old verdict when their
inventory refreshes.

This is observed client-side health, not a credential validation endpoint or
a fleet-wide health guarantee. An externally changed environment or key on
another client is not detected until a configuration refresh or a request
provides new evidence. The app never probes a provider merely to display the
status. Chat error copy and upstream Gateway mappings are unchanged.

## Availability

Generally available. The rollout flag is retired; organization/member overrides,
operator locks and old kill-switch rows no longer disable this behavior.
Authorization, provider setup, consent and runtime compatibility still apply.
