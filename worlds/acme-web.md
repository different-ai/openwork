# Acme Web

Seeded Acme Den, the OpenWork web app, a managed OpenCode engine, and the real
`ee/apps/gateway` service. Only the Anthropic-compatible upstream is simulated;
it returns **Acme AI Gateway is working.** No paid model credentials or LiteLLM
are required.

## Start

Use a checkout with dependencies installed in both the repository and `evals`.
The co-located runtime needs MySQL, Redis, Node, pnpm, and OpenCode. Prepare the
shared packages once:

```sh
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm world up acme-web --place local --stage gateway-demo --detach --timeout 600000
pnpm world outputs acme-web --stage gateway-demo
```

The world owns a scratch database and an isolated OpenCode workspace. Den and
Gateway share that database and encryption key. Provider creation, member-key
issuance, model aliases, managed provider sync, gateway authorization, native
protocol forwarding, and usage accounting use the product implementations.

Startup completes only after a real OpenCode chat returns the deterministic
reply through the gateway. The verification conversation is retained for
inspection. This is runtime-path verification, not proof of browser sign-in.

Open `webUrl`, sign in to `denWeb` as `alex@acme.test`, and select **Acme AI
Gateway / Claude Haiku 4.5**. Retrieve the fixture password privately:

```sh
pnpm world outputs acme-web --stage gateway-demo --reveal
```

Send a message and expect the fixed reply. Reload or switch workspaces to
inspect the composer model title; the `gwm_*` routing alias must not flash as
the label. Gateway access can be managed in Den's AI Gateway screen.

## Automated regression

```sh
pnpm evals:pr specs/acme-web-gateway.test.ts
```

This cold-boots the same composition and verifies:

- the real Den inventory creates an `ipr_*` provider and `gwm_*` model alias;
- the human-readable model name reaches the managed OpenCode runtime;
- upstream credentials do not appear in runtime provider configuration;
- an OpenCode chat reaches the real gateway and authenticated upstream;
- request accounting records the organization, alias, upstream model, tokens,
  and a positive cost;
- invalid gateway keys and revoked access grants cannot reach the upstream.

Run one Den-web world/test per worktree because Next.js holds a worktree-local
development lock. Stop the preview before running the cold-boot regression.
Tests can import `bootAcmeWeb` and `probeAcmeGateway` and own teardown with an
`AsyncDisposableStack`.

```sh
pnpm world down acme-web --stage gateway-demo
```

This world runs co-located (`--place local`) or inside a private Freestyle VM.
Host-driven `--place daytona` provisioning is not implemented. It exercises organization AI Gateway providers, not the separate
OpenWork Models subscription/credit-billing flow.

## Private Freestyle review

The reviewer can launch **ACME web · Full stack** from the report's exact commit.
Its snapshot prepares the repository, MySQL and Redis; each clone boots and seeds
its own full world, then verifies a real OpenCode request through AI Gateway.
The model upstream alone is deterministic. This is an isolated demo, not production
accounts or billing. Initial preparation can take several minutes.

```sh
pnpm world up acme-web --place freestyle --detach --timeout 800000 -- --ref <full-pushed-sha>
pnpm world outputs acme-web --reveal
pnpm world down acme-web
```

The private review exposes grouped service links and **Reveal outputs** for demo
passwords, bearer tokens and connection strings. **Copy outputs** copies masked
values until reveal is enabled. Each HTTP service has its own access link; API
clients can use the revealed preview cookie plus the service's bearer token.
MySQL and Redis addresses are VM-local, not publicly reachable. Freestyle account
credentials never appear in world outputs. All connections expire with the VM.
