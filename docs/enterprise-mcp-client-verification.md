# Enterprise MCP Client Verification Rehearsal

This branch is a verification-only composition of two separately reviewable source branches:

- `feature/enterprise-mcp-client` — the package-first remote MCP client and Den adapters;
- `feature/mcp-diagnostic-mock-server` — the reusable provider-shaped mock package and protected EE lab.

It is based on current upstream `dev`, which already includes structured MCP diagnostics from #2669. This branch must not replace the source PRs or be merged wholesale as the production feature. Its purpose is to let Jalil and maintainers prove the package boundary against realistic Microsoft and ServiceNow flows before deciding what to accept.

## Managerial verification matrix

| Provider fixture | Healthy proof | Failure proof | Result |
| --- | --- | --- | --- |
| ServiceNow inbound MCP | Confidential OAuth, PKCE, token commit, MCP initialize, complete paged catalog, safe `lookup_incidents` read | Wrong client secret | Passed; failure assigned to OAuth token exchange |
| Microsoft Enterprise MCP | Confidential Entra-shaped OAuth, PKCE, token commit, MCP initialize, complete catalog, safe query-suggestion read | Wrong client secret with `AADSTS7000215` fixture | Passed; failure assigned to OAuth token exchange |

The test uses only synthetic loopback data. It performs no customer or provider call and contains no live tenant ID, client ID, secret, authorization code, token, or customer content.

## What the rehearsal found

The first combined run exposed a real package defect. A token endpoint could reject the client secret, then the MCP SDK could perform a later successful metadata request during cleanup. The package reported the last request—OAuth server discovery—instead of the last failed request—OAuth token exchange.

The source package now retains both facts separately:

- `lastRequestPhase` supports successful-operation tracing;
- `lastFailedRequestPhase` owns terminal failure attribution.

The correction lives in `feature/enterprise-mcp-client`, not only in this rehearsal. Both provider fixtures now assert `requestPhase=oauth-token-exchange` for invalid-client failures.

## Automated verification

From the repository root:

```bash
pnpm --filter @openwork/enterprise-mcp-client test
pnpm --filter @openwork/enterprise-mcp-client typecheck
```

The test command first builds the mock package through its public package boundary. It then runs the package's normal tests plus four cross-package cases:

1. healthy ServiceNow OAuth → MCP → catalog → safe read;
2. invalid ServiceNow client secret;
3. healthy Microsoft OAuth → MCP → catalog → safe read;
4. invalid Microsoft client secret with Entra-shaped evidence.

## Start the review environment

Prepare the isolated Den database once:

```bash
./bin/openwork-hub den-init mcp enterprise-mcp-client-verification
```

Start Den with the package-first client enabled:

```bash
./bin/openwork-hub run mcp enterprise-mcp-client-verification -- \
  env DEN_ENABLE_ENTERPRISE_MCP_CLIENT=true pnpm dev:den
```

In another terminal, start the protected mock lab with a development-only secret:

```bash
./bin/openwork-hub run mcp enterprise-mcp-client-verification -- \
  env ENTERPRISE_MOCK_LAB_ADMIN_SECRET=replace-with-32-plus-development-characters \
  ENTERPRISE_MOCK_LAB_PORT=8794 \
  pnpm --filter @openwork-ee/enterprise-mock-lab dev
```

## Manual review sequence

1. Sign in to Den as the local Alex demo administrator.
2. Open the lab and sign in with its development-only admin secret.
3. In Den, prepare a manual/pre-registered external MCP connection and copy Den's exact callback URI.
4. In the lab, create either `servicenow-inbound-quickstart` or `microsoft-enterprise` on a fixed unused data-plane port. Register the exact Den callback, client ID `enterprise-mcp-test-client`, and a synthetic secret shared only between Den and the local fixture.
5. Start the fixture, then Connect from Den. Confirm authorization returns to Den and the connection becomes ready.
6. Run the Den Test Connection path. Confirm initialization and the complete catalog pass; this still does not claim a real provider operation or mutation.
7. Reset OAuth state, change Den to an intentionally wrong synthetic secret, and Connect again. Confirm the first failed phase is token acquisition/exchange, not issuer discovery or generic connection failure.
8. Restore the matching synthetic secret, reconnect, run one safe read, and clean up the instance.

## Evidence boundaries

This rehearsal proves the package/client/mock contract. It does not prove:

- a customer ServiceNow family, patch, ACL, domain policy, or network allowlist;
- Microsoft Work IQ, Agent 365, or Microsoft Enterprise MCP tenant eligibility;
- real Microsoft or ServiceNow provider operations or mutations;
- customer proxy, custom CA, egress, Conditional Access, licensing, or regional rollout behavior.

Those remain separate approved-tenant verification gates.
