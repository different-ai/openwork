# @openwork/sandbox-connect

Reach a port inside any provider's sandbox as `http://127.0.0.1:<port>`.

A provider adapter lists every route it can offer through the `routes` block in
`@openwork/sandbox` (an HTTPS edge such as a preview URL or a bound domain, and
an SSH gateway). This package races them and keeps the first that answers.
If one provider service fails, such as a preview proxy that returns 502, a run
falls back to another route instead of failing.

```ts
import { connectProviderCdp } from "@openwork/sandbox-connect"

await using browser = await connectProviderCdp(provider, handle, 9222)
// browser.url: plain loopback CDP for Playwright, puppeteer or @openwork/cdp.
// browser.route: which route won, e.g. { kind: "ssh", label: "daytona-ssh" }.
```

Code that already has routes calls `connectSandboxPort(routes, { check })` or
`connectSandboxCdp(routes)` directly. `packages/daytona-evidence` does this.

| Route | How | Survives |
| --- | --- | --- |
| `https` | loopback relay that adds access headers | an SSH gateway outage |
| `ssh` | system `ssh -N -L` plus the relay when headers are needed | a preview/edge proxy outage |

Rules:

- Tokens never reach argv, URLs or logs. The SSH user, which holds the token,
  goes in a private `ssh -F` file. Failures are reported as fixed words
  (`auth`, `forward-refused`, `network`, `timeout`).
- Every route is released when it loses or when the connection closes, so
  short-lived credentials (Daytona SSH tokens, Freestyle identities) are revoked.
- To add a provider, implement `blocks.routes` in its adapter. Callers don't
  change.

Requires an `ssh` client on the machine that connects. GitHub and Blacksmith
Ubuntu runners have one.
