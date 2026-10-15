# OpenWork Web sign-in

A web build served by `ee/apps/den-gateway` receives its Den address from
`DEN_GATEWAY_DEN_WEB_URL`. Desktop builds and plain/self-hosted app servers
without a gateway marker keep their existing sign-in behavior.

## Optional automatic handoff

`webSigninRedirect` is a registry rollout for cloud and self-hosted deployments,
**off by default**. Enable it for everyone in Den's `/admin` Features page. A
signed-out visitor has no organization yet, so an organization-only override
cannot enable this entry flow. Self-hosted operators can also use the generated
Helm `config.features.webSigninRedirect` lock. The kill switch takes precedence.

When enabled, the gateway app checks the Den session before starting one
same-tab navigation to its configured Den sign-in. The existing web handoff
sends only the gateway **origin** as `webAuthReturn`; Den continues to validate
that origin and returns its one-time grant to `/signin`. No server return-URL
allowlist is broadened. The original app path, query and fragment stay in the
tab's session storage and are restored after a successful exchange, never taken
from a caller-supplied external return URL.

An existing Den browser session completes without a click. Otherwise the visitor
signs in at Den in that same tab. Manual retries also use that tab when the
rollout is on and the URL supports web handoff.

## Recovery and boundaries

- One automatic attempt per configured Den per tab prevents repeated navigation
  after a failed or interrupted handoff. A manual sign-in remains available.
- Grant/error callbacks never start another automatic round trip. Failed grant
  exchanges keep the existing error/retry surface.
- Blocked session storage, missing/failed feature reads, an unconfigured Den,
  and same-origin Den/gateway configuration fall back to manual sign-in.
- Desktop/Electron, explicit desktop builds and
  `VITE_OPENWORK_FORCE_MANUAL_AUTH=1` keep the existing external-browser flow.
  HTTP/loopback app origins also keep the manual grant handoff: Den's approved
  web return URL must be HTTPS.
- Turning the feature off restores the manual gate and popup behavior for new
  attempts. An already-started callback still completes and restores its route.
  No credentials, enrollment, organization choice or stored work are deleted.

Regression proof: `evals/specs/web-signin-redirect.e2e.test.ts` runs the production
web build through the real gateway and Den in headless Chrome. Pure URL,
loop-protection, storage-failure and browser-opening checks live in
`apps/app/tests/web-signin-redirect.test.ts`.
