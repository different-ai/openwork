# MCP conformance baseline

Status as of 2026-07-17: stable production baseline qualified by OpenWork
tests; current protocol release candidate disabled by default and not claimed
as production-conformant.

## Pinned primary sources

| Surface | Exact baseline | Use |
| --- | --- | --- |
| Stable MCP specification | `modelcontextprotocol/modelcontextprotocol` tag `2025-11-25` at `38c84e9f93ad191d9eb26d92b945d17bd0efcaf3` | Production producer, client, and health-probe policy |
| Current release-candidate source | `modelcontextprotocol/modelcontextprotocol` at `26897cc322f356487da89113451bd16b520b9288` | Disabled-by-default kernel vectors only |
| TypeScript SDK | `@modelcontextprotocol/sdk@1.29.0` plus the repository patch recorded by `pnpm.patchedDependencies` | Stable production lifecycle |
| Official conformance framework | `@modelcontextprotocol/conformance@0.2.0-alpha.9`, source `ce25103b1baa6e0653e0b7bf4f79de385ea7a116` | Provisional runner; results must record the source commit because the package is alpha |

The current TypeScript v2 SDK and July 28 specification were not stable at
this baseline date. A matching date-shaped protocol identifier is not evidence
that the final specification, SDK, OpenCode projection, or packaged desktop
path has passed qualification.

## Claimed support

| Plane | `2025-11-25` | `2026-07-28` release candidate |
| --- | --- | --- |
| Den `/mcp/agent` producer | Production baseline; authenticated legacy lifecycle and exact two-tool facade | Rejected with HTTP 400 / JSON-RPC `-32022`; stable is advertised as the only qualified version |
| Den downstream enterprise client | Production baseline through SDK v1.29.0 and guarded network/OAuth adapters | SDK-independent request, response, schema, routing, result, cache, and downgrade primitives only |
| OpenWork Server delivery probe | Sends and requires `2025-11-25`; verifies the exact two-tool catalog | Not attempted |
| Shipped OpenCode engine | Existing stable lifecycle only | Not qualified; no current-protocol support is claimed |

## Promotion gate

Current protocol traffic remains disabled until all of the following are
recorded against final, immutable sources:

1. final specification and stable SDK diff review;
2. 100% of applicable required official producer and client checks;
3. OAuth/resource/issuer/PKCE/refresh regression matrix;
4. authenticated Den single-instance and round-robin journeys;
5. an explicit OpenCode binary compatibility verdict and digest;
6. schema-fidelity proof from provider catalog through effective model tools;
7. multi-round-trip replay, expiry, cancellation, and actor-binding proof; and
8. stable rollback without credential recreation or migration.

Expected failures may document a known gap, but a stale baseline or an
unexpected failure fails the gate. Optional capabilities that OpenWork does
not advertise are not conformance claims.
