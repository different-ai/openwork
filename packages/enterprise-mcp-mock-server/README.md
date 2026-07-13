# `@openwork/enterprise-mcp-mock-server`

A reusable, deterministic TypeScript package for developing and testing enterprise OAuth and remote MCP integrations without customer tenants, provider credentials, or outbound provider calls.

This package owns the mock **data plane**. It deliberately does not import Den, an OpenWork client, or the Enterprise Mock Lab. The lab consumes this public API and supplies the protected control plane.

## Design boundaries

- Declarative, immutable, Zod-validated scenarios.
- One named fault at one canonical handshake phase.
- Provider topology/catalog fixtures are separate from MCP specification behavior.
- Literal loopback listeners only (`127.0.0.1` or `::1`).
- Synthetic data only; no network calls leave the local mock/probe origin.
- Tokens, codes, sessions, request bodies, client secrets, and tool arguments are not retained in trace events.
- Bounded clients, codes, tokens, sessions, operations, counters, bodies, pages, and events.
- Runtime lifecycle operations are serialized; reset/update drain active work before replacing state.
- Mutations require explicit mock approval and idempotency keys. A lost response after commit remains `indeterminate` and cannot be replayed as success.

Mutation keys are scoped to the synthetic OAuth client/subject rather than globally across clients. `stop()` preserves the mutation ledger across a listener restart; `reset()`, scenario replacement, and instance deletion discard operations. The opt-in compatible-OAuth scenario mode still clears every operation, MCP session, authorization code, fault counter, and earlier event. Only completed `responded` entries are eligible for 24-hour expiry or bounded eviction. If 1,000 unresolved entries fill the ledger, new mutations fail closed with `MUTATION_LEDGER_CAPACITY` until the operator reconciles or resets; unresolved outcomes are never forgotten to make room.

## Public API

```ts
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  createFaultScenario,
  listFaultDefinitions,
  listProviderProfiles,
  probeEnterpriseMcpMockServer,
} from "@openwork/enterprise-mcp-mock-server"

const clientSecret = process.env.MOCK_OAUTH_CLIENT_SECRET ?? ""

const scenario = createDefaultScenario("servicenow-inbound-quickstart")
const server = createEnterpriseMcpMockServer({
  scenario,
  secrets: { oauthClientSecret: clientSecret },
})

await server.start()

const result = await probeEnterpriseMcpMockServer({
  baseUrl: server.baseUrl,
  scenario,
  credentials: { clientSecret },
  mode: "fixture-conformance",
})

await server.stop()
```

The controller exposes:

- `start()` / `stop()` / `reset()`
- `updateScenario(next, expectedRevision, options?)` with optimistic revision checking
- `snapshot()` with secret-free bounded state
- `events()` with redacted phase-specific trace events
- `baseUrl` and `mcpUrl` after startup

An optional `EnterpriseMcpMockEnvironment` injects time and ID generation for deterministic tests. Secure random defaults are used otherwise.

Scenario updates default to `credentialContinuity: "reset"`. A caller may explicitly request `preserve-compatible-oauth` when iterating post-authentication catalog or provider-operation faults on a fixed-port server. Preservation is rejected unless the provider fixture, endpoint/resource, OAuth registration/client, exact redirects, authorization scopes, and required resource scopes are unchanged. It copies only unexpired client registrations and their access/refresh tokens into the new state. Authorization codes, MCP sessions, operations, counters, and events are always discarded, so the client must initialize a new MCP session. OAuth-layer faults require reset mode and a new authorization flow.

`oauthClientSecret` is required only when a manual profile uses `client_secret_post` (for example ServiceNow or Microsoft Enterprise). It may be empty for public-client profiles and for dynamic registration, where the mock registration endpoint issues its own synthetic credential.

The `oauth-invalid-client` fault is profile-aware. Microsoft profiles return an Entra-shaped `invalid_client` response with safe `AADSTS7000215`, trace, correlation, and timestamp fields matching the failure class verified against a development tenant. ServiceNow returns an OAuth `invalid_client` response with ServiceNow-specific client-ID/client-secret remediation grounded in its setup and troubleshooting documentation. Neither fixture echoes the submitted secret, and the ServiceNow response wording remains explicitly synthetic until it is captured from an approved test instance. See the [Microsoft identity error reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes) and ServiceNow's [OAuth endpoint setup](https://www.servicenow.com/docs/r/platform-security/authentication/t_CreateEndpointforExternalClients.html) and [invalid-secret troubleshooting guidance](https://www.servicenow.com/docs/r/platform-security/identity/scim-troubleshooting.html).

## Profiles

| Profile | Fidelity boundary |
| --- | --- |
| `synthetic-enterprise-oauth-mcp` | OAuth/MCP standards-conformance profile, including DCR; no vendor claim |
| `servicenow-inbound-quickstart` | Documented inbound Quickstart path, manual OAuth paths, `mcp_server`; synthetic provider behavior |
| `microsoft-work-iq` | Documented Work IQ endpoint, delegated scope, ten tools, and current input names/types; bounded synthetic schemas/results plus explicit mock-only mutation controls |
| `microsoft-enterprise` | Documented `https://mcp.svc.cloud.microsoft/enterprise`, Entra resource, `.default` token-request scope, and read-only catalog; synthetic schemas/results |
| `agent-365-mail-v1-2026-07` | Dated preview endpoint/manifest/tool-name snapshot; synthetic tool schemas and mailbox behavior |

Each profile carries a stable `fixtureVersion`, documentation URLs, verification date, preview state, provider release description, and limitations. Scenarios pin that fixture version so a later profile update cannot silently reinterpret old evidence. `provenance.aspectFidelity` labels endpoint, authorization, catalog, tool-schema, provider-result, and transport fidelity independently. Provider OAuth field values may follow documented topology, but authorization behavior is labelled synthetic because the package does not reproduce Entra or ServiceNow identity systems. Provider profiles never claim that synthetic auth/results, bounded mock-only schemas, or MCP response mode/version behavior are provider-observed.

Work IQ follows the Microsoft tool reference updated 2026-06-03: `fetch` uses `entityUrls`; entity mutations use `parentUrl` or `entityUrl` plus a JSON-encoded `jsonBody`; actions/functions use `actionUrl`/`functionUrl`; `ask`, `list_agents`, `get_schema`, and `search_paths` use their documented input names and types. The bounded schemas are labelled synthetic because `approved` and `idempotency_key` are mock-only mutation extensions. The restricted mock schema chooses the documented `path` variant for `get_schema` and requires `path` plus `operationType`; it does not claim to encode the provider's `operationIds`/`path` exclusive-or rule.

The Microsoft Enterprise profile requests the documented `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default` scope. A real tenant must separately grant enabled delegated `MCP.*` permissions such as `MCP.User.Read.All`; this mock does not emulate Entra `.default` expansion. The Agent 365 Mail profile preserves dated endpoint, audience, scope, and tool-name evidence while explicitly labelling its argument shapes and results synthetic.

## OAuth scope model

`authorizationScopes` and `requiredResourceScopes` are intentionally separate. For example, `offline_access` may be requested to obtain refresh authority but is never treated as an MCP resource permission.

Redirect URIs must use HTTPS, except HTTP on literal numeric loopback. Credentials, fragments, custom schemes, `localhost`, and deceptive loopback-looking hostnames are rejected.

## Fault contract

`listFaultDefinitions()` returns the supported catalog. Each definition declares:

- a stable kebab-case identifier;
- the exact first handshake phase;
- canonical category and operator action;
- retryability;
- applicable profiles;
- wire-level effect;
- diagnostic level: `connection`, `readiness`, or `operation`.

`createFaultScenario(profileId, faultId)` adjusts any required transport detail—such as SSE response mode or catalog page size—so the selected fault is causally reachable without hidden test configuration.

## Probe safety

The included probe is intentionally restricted to literal loopback. It:

1. Begins with a real unauthenticated MCP request.
2. Follows `resource_metadata` from the actual `WWW-Authenticate` challenge.
3. Pins all discovered OAuth endpoints to the original local origin.
4. Performs exact redirect, state, resource, scope, and PKCE binding.
5. Negotiates MCP and verifies JSON-RPC IDs, session/protocol headers, notification status, bounded pagination, unique tools, and schemas.
6. Preserves provider tool errors as provider outcomes.
7. Compares observed phase/category with the scenario expectation only after independent wire classification.
8. Cleans up sessions and revokes tokens without replacing the primary failure.

Probe modes are explicit:

- `connection-readiness` accepts any valid non-empty catalog and executes no tool;
- `fixture-conformance` (the default) also requires the exact tool names pinned by the profile fixture and executes no tool;
- `safe-read` adds one synthetic read-only tool call.

The probe bounds every response body to 1 MiB, applies a 30-second overall deadline by default, and redacts credentials and OAuth artifacts from returned error messages. An empty catalog is protocol-valid MCP; the lab classifies it as an enterprise **readiness** failure (`catalog_empty`), not as a connection failure.

## Validation

```bash
pnpm --filter @openwork/enterprise-mcp-mock-server check
```

The suite contains independent wire tests in addition to the package probe, including OAuth topology/PKCE/rotation, DCR modes, hostile Origin, cross-token session isolation, JSON-RPC/transport validation, argument schemas, mutation reconciliation, state bounds/redaction, active-request shutdown, all advertised faults, and an adversarial test proving expected fault metadata cannot manufacture a passing diagnosis.
