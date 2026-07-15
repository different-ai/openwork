# Enterprise MCP Mock Lab

## Manager summary

The Enterprise MCP Mock Lab gives developers a safe, repeatable place to reproduce an enterprise MCP connection before involving a customer tenant. It separates the reusable protocol simulation from the local admin experience:

```text
enterprise-mock-lab
  -> enterprise-mcp-mock-server
       -> MCP, OAuth, HTTP, and JSON-RPC contracts only
```

This matters because a single “failed to connect” message can hide very different causes. The lab records the expected and observed outcome and names the **first failed phase**—for example, OAuth discovery, token validation, MCP initialization, tool discovery, provider authorization, or provider execution. That lets a reviewer explain what failed and who can act on it without treating every failure as a generic MCP outage.

The lab is a development and regression-test foundation. It is not a replacement for testing against an approved Microsoft 365 or ServiceNow test tenant.

## Purpose and non-goals

The lab is designed to:

- reproduce a deterministic OAuth and MCP lifecycle on a developer machine;
- model documented ServiceNow, Work IQ, Microsoft Enterprise MCP, and Agent 365 surfaces with synthetic data;
- inject one named fault at a time so the first failure stays unambiguous;
- expose immutable scenario revisions and expected-versus-observed results;
- preserve safe phase, category, and correlation evidence without returning secrets or request bodies;
- support both manual investigation and automated regression tests.

It does **not**:

- authenticate against Entra ID or a ServiceNow identity provider;
- call Microsoft Graph, Microsoft 365, Agent 365, or ServiceNow;
- prove tenant licensing, rollout, entitlement, Conditional Access, ACL, guardian, domain-separation, proxy, or patch behavior;
- validate production JWT signatures or issue tokens with authority outside this process;
- provide production persistence, multitenancy, high availability, or compliance controls;
- make a provider-observed claim unless evidence from an approved test tenant is separately captured and dated.

## Package-first boundary

The reusable package is [`packages/enterprise-mcp-mock-server`](../packages/enterprise-mcp-mock-server). It owns declarative contracts, provider profiles, the fault catalog, protocol behavior, the in-memory runtime, safe traces, and the probe. It must remain usable without Den or the EE app.

The local admin application is [`ee/apps/enterprise-mock-lab`](../ee/apps/enterprise-mock-lab). It owns process configuration, authentication, CSRF/origin enforcement, instance lifecycle, the HTML interface, and the control-plane API. It consumes the package only through its public exports.

Dependency rules:

1. `enterprise-mock-lab` may depend on `enterprise-mcp-mock-server`.
2. `enterprise-mcp-mock-server` must not import Den, an EE app, OpenWork's MCP client, or a provider SDK.
3. Den must not import the EE app. A future Den test connects to a lab data-plane URL like any other remote MCP client.
4. Provider differences belong in named, sourced profiles or faults—not hidden environment checks.
5. Runtime secrets and ports belong to the app or test harness, never to package fixtures.

## Two-plane threat model

The lab deliberately uses two kinds of loopback listener.

| Boundary | Purpose | Allowed data | Main protections |
| --- | --- | --- | --- |
| Control plane | Create instances, select scenarios, run probes, inspect safe events | Admin session, CSRF token, profile-dependent write-only synthetic OAuth client secret, sanitized instance state | Loopback-only host, 32+ character admin secret, constant-time comparison, bounded rate/session state, `HttpOnly`/`SameSite=Strict` session cookie, exact Origin and session checks before bounded body parsing, CSRF validation, 64 KiB request limit, restrictive browser headers |
| Data plane | Behave like one synthetic provider MCP endpoint | Synthetic OAuth artifacts, MCP messages, synthetic tools and records | Separate loopback port per instance, no admin routes, deterministic fake authority, bearer values excluded from safe traces |
| Provider boundary | Represent a Microsoft or ServiceNow operation | Synthetic records and provider-shaped error evidence | No outbound calls, no customer data, explicit fidelity and limitations |

The control plane defaults to plain HTTP because it is loopback-only development infrastructure. Do not bind it or an instance data plane to a LAN or public interface. Use a separate TLS/proxy harness when the behavior being tested is certificate trust, TLS interception, DNS, or egress.

There are three different secret concepts. Keep them separate:

- the **lab admin secret** unlocks the local control plane;
- the **mock OAuth client secret** represents a synthetic confidential client;
- any future **real provider credential** belongs outside this lab and must never be entered here.

The first two are local synthetic inputs, held in process memory and represented in responses only by configured/not-configured booleans. The OAuth secret is required for manual confidential-client profiles such as ServiceNow and Microsoft Enterprise; public-client Work IQ and Agent 365 profiles leave it blank.

## Start the lab

From the repository root, install dependencies once, generate a fresh local admin secret, and start the app:

```bash
pnpm install
export ENTERPRISE_MOCK_LAB_ADMIN_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'Local lab admin secret: %s\n' "$ENTERPRISE_MOCK_LAB_ADMIN_SECRET"
pnpm --filter @openwork-ee/enterprise-mock-lab dev
```

Open `http://127.0.0.1:8794` and paste the generated admin secret. The control plane starts with no mock instances; creating an instance does not start it automatically.

### Process configuration

| Variable | Required | Default | Contract |
| --- | --- | --- | --- |
| `ENTERPRISE_MOCK_LAB_ADMIN_SECRET` | Yes | none | At least 32 characters; checked in memory and never returned |
| `ENTERPRISE_MOCK_LAB_HOST` | No | `127.0.0.1` | Only `127.0.0.1` or `::1` |
| `ENTERPRISE_MOCK_LAB_PORT` | No | `8794` | Control-plane port, `1`–`65535` |
| `ENTERPRISE_MOCK_LAB_SESSION_TTL_SECONDS` | No | `3600` | Admin session lifetime, `300`–`86400` seconds |

Each instance also has an independent data-plane port, provider profile, scenario revision, and write-only synthetic credentials. A port can belong to only one lab instance at a time.

## Provider profiles and fidelity

Fidelity is a claim with evidence, not a marketing label:

- `spec-conformant`: behavior is asserted against a named stable protocol specification;
- `provider-documented`: the shape follows dated official provider documentation but has not been observed in a live tenant;
- `provider-observed`: behavior was captured from an approved test tenant with dated, redacted evidence;
- `synthetic`: useful lab behavior without a provider-equivalence claim.

Fidelity is recorded per aspect rather than inherited from one broad provider label. `provenance.aspectFidelity` independently identifies endpoint, authorization, catalog, tool-schema, provider-result, and transport evidence. Provider OAuth field values follow dated documentation where stated, but authorization behavior is labelled synthetic because the lab does not emulate Entra or ServiceNow identity systems. The provider profiles use synthetic identities and results even where their endpoint or catalog is provider-documented. A separate standards profile is **spec-conformant** and intentionally makes no Microsoft or ServiceNow product claim.

| Profile ID | Product surface | Documented auth shape | Verified | Important boundary |
| --- | --- | --- | --- | --- |
| `synthetic-enterprise-oauth-mcp` | Standards-conformance OAuth/MCP surface | DCR or manual registration; `mcp.read`, `mcp.write`, `offline_access` | 2026-07-10 | Represents no Microsoft or ServiceNow product |
| `servicenow-inbound-quickstart` | ServiceNow MCP Server Console inbound Quickstart server | Manual registration; `mcp_server` acquisition and resource scope | 2026-07-10 | Customer family, patch, plugins, ACLs, domain separation, and transport behavior must be rechecked |
| `microsoft-work-iq` | Microsoft Work IQ MCP | `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask` plus `offline_access`; audience `api://workiq.svc.cloud.microsoft` | 2026-07-12 | Ten tool names/input names and types are documented; bounded schemas, mutation safety extensions, and results are explicitly synthetic |
| `microsoft-enterprise` | Microsoft MCP Server for Enterprise at `https://mcp.svc.cloud.microsoft/enterprise` | Resource `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4`; documented token-request scope `{resource}/.default` | 2026-07-12 | Real tenants must grant enabled delegated `MCP.*` permissions; schemas/results, revocation, app-only, sovereign cloud, and transport behavior are not claimed |
| `agent-365-mail-v1-2026-07` | Work IQ Mail / Agent 365 `mcp_MailTools`, V1 manifest snapshot | `McpServers.Mail.All` plus `offline_access`; audience `api://05879165-0320-489e-b644-f72b33f3edf0` | 2026-07-12 | Preview; endpoint, manifest, and ten dated tool names are documented, while argument schemas/results are explicitly synthetic and rollout/eligibility need live revalidation |

The UI shows each profile's stable fixture version, documentation links, verified date, per-aspect fidelity, and known limitations. Scenario evidence pins the fixture version; review those fields before using a profile as the basis for a product decision.

Profile source register (retrieved or rechecked through 2026-07-12 unless a profile records an earlier verification date):

- MCP stable [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization);
- ServiceNow [create an MCP server](https://www.servicenow.com/docs/r/intelligent-experiences/create-mcp-server.html) and [connect an MCP server/client](https://www.servicenow.com/docs/r/intelligent-experiences/connect-mcp-server-client.html);
- Microsoft [Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview), [permissions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions), and [tool reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference);
- Microsoft [MCP Registry EnterpriseMCP entry](https://github.com/mcp/io.github.microsoft/EnterpriseMCP), [MCP Server for Enterprise getting started](https://learn.microsoft.com/en-us/graph/mcp-server/get-started), and [Copilot Studio connection fields](https://learn.microsoft.com/en-us/graph/mcp-server/use-enterprise-mcp-server-copilot-studio);
- Microsoft [Work IQ Mail MCP](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-mail-work-iq) and [Agent 365 developer tooling](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling).

## Declarative scenarios and revisions

A scenario is data, not a web of ad hoc conditionals. Its essential shape is:

```json
{
  "schemaVersion": 1,
  "id": "servicenow-inbound-quickstart-provider-authorization-denied",
  "revision": 2,
  "profileId": "servicenow-inbound-quickstart",
  "profileFixtureVersion": "2026-07-12.1",
  "protocol": {
    "version": "2025-11-25",
    "responseMode": "json",
    "requireSession": true,
    "pageSize": 2
  },
  "oauth": {
    "registration": "manual",
    "clientId": "enterprise-mcp-test-client",
    "redirectUris": ["http://127.0.0.1:19876/mcp/oauth/callback"],
    "authorizationScopes": ["mcp_server"],
    "requiredResourceScopes": ["mcp_server"]
  },
  "activeFault": {
    "id": "provider-authorization-denied",
    "trigger": { "occurrence": "always" }
  },
  "expected": {
    "outcome": "failure",
    "firstFailedPhase": "PROVIDER_AUTHORIZATION",
    "category": "provider_authorization_denied"
  }
}
```

The lab allows one active fault by default. Applying a change creates a new positive integer revision. The caller must send `expectedRevision`; a stale write receives a conflict instead of silently overwriting another developer's scenario. A request uses the scenario revision it started with, so a mid-request admin change cannot make its evidence internally inconsistent.

Scenario activation has an explicit credential-continuity choice. The manager-facing form selects `preserve-compatible-oauth` for catalog and provider-operation iteration: after draining active requests, the lab keeps only compatible, unexpired OAuth client/access/refresh authority and requires the client to create a new MCP session. Pending authorization codes, prior MCP sessions, operation records, fault counters, and prior events never cross the revision boundary. Preservation is rejected if the fixed endpoint/resource, provider fixture, client registration, exact redirects, or scopes changed. API callers can send `reset` for the original full reset behavior, and omission still means `reset` for backward compatibility. OAuth-layer faults require full reset and a fresh **Connect**; an already-issued credential cannot honestly exercise discovery, registration, consent, or token acquisition again.

`Reset` clears runtime state and safe events but intentionally keeps the active scenario. To recover to the healthy baseline, reset the instance, apply a new revision with no fault, and probe again.

## Fault-to-first-failure matrix

The following matrix is the exact initial fault contract. “Error source” names the boundary that should own the first actionable explanation; the category is the machine-readable value returned by the probe.

Each fault also has a machine-readable diagnostic level. `connection` means OAuth/MCP connectivity failed; `readiness` means the connection worked but the catalog is not usable under this lab's enterprise policy; `operation` means connection and catalog succeeded before a provider/tool operation failed. This distinction prevents an empty but protocol-valid catalog or a provider ACL denial from being reported as a generic connection outage.

| Fault ID | First failed phase | Error category | Error source |
| --- | --- | --- | --- |
| `oauth-missing-auth-challenge` | `AUTH_RESOURCE_DISCOVERY` | `oauth_discovery_resource` | MCP resource server's unauthenticated OAuth challenge |
| `oauth-malformed-resource-metadata` | `AUTH_RESOURCE_DISCOVERY` | `oauth_discovery_resource` | OAuth protected-resource metadata document |
| `oauth-issuer-mismatch` | `AUTH_ISSUER_DISCOVERY` | `oauth_discovery_issuer` | Authorization-server metadata issuer |
| `oauth-pkce-s256-unsupported` | `AUTH_ISSUER_DISCOVERY` | `oauth_pkce_unsupported` | Authorization server's PKCE capabilities |
| `oauth-dynamic-registration-unsupported` | `AUTH_CLIENT_REGISTRATION` | `oauth_client_registration` | OAuth dynamic client registration endpoint |
| `oauth-invalid-client` | `AUTH_TOKEN_ACQUISITION` | `oauth_client_registration` | Token endpoint client authentication; Microsoft fixtures emit safe `AADSTS7000215` trace/correlation evidence, while ServiceNow fixtures emit provider-specific credential remediation. Both remain synthetic fixtures, not captured customer responses. |
| `oauth-invalid-grant` | `AUTH_TOKEN_ACQUISITION` | `oauth_token` | Token endpoint authorization grant validation |
| `oauth-wrong-resource-audience` | `AUTH_RESOURCE_VALIDATION` | `oauth_wrong_audience` | MCP resource server's token audience/resource validation |
| `oauth-insufficient-scope` | `AUTH_RESOURCE_VALIDATION` | `oauth_insufficient_scope` | MCP resource server's required scope validation |
| `mcp-version-unsupported` | `MCP_VERSION` | `mcp_version` | MCP version negotiation |
| `mcp-initialize-malformed` | `MCP_INITIALIZE` | `mcp_initialize` | MCP initialize response/JSON-RPC correlation |
| `mcp-session-expired` | `CONTINUITY_SESSION` | `mcp_session_expired` | MCP session continuity on a post-initialize request |
| `mcp-initialized-rejected` | `MCP_INITIALIZED` | `mcp_lifecycle` | MCP initialized-notification lifecycle |
| `mcp-wrong-content-type` | `MCP_TRANSPORT` | `mcp_transport` | Streamable HTTP response content type |
| `mcp-broken-sse` | `MCP_TRANSPORT` | `mcp_transport` | Streamable HTTP SSE framing |
| `mcp-empty-tool-catalog` | `MCP_TOOL_DISCOVERY` | `catalog_empty` | Enterprise readiness policy after a protocol-valid empty MCP catalog; not a connection failure |
| `mcp-catalog-cursor-loop` | `MCP_TOOL_DISCOVERY` | `mcp_pagination_loop` | MCP tool-catalog pagination |
| `mcp-duplicate-tool` | `MCP_TOOL_DISCOVERY` | `mcp_duplicate_tool` | MCP tool identity across catalog pages |
| `mcp-invalid-tool-schema` | `MCP_TOOL_DISCOVERY` | `mcp_invalid_tool_schema` | Tool input-schema contract |
| `provider-authorization-denied` | `PROVIDER_AUTHORIZATION` | `provider_authorization_denied` | ServiceNow ACL/domain role or Microsoft workload permission, after MCP succeeds |
| `provider-policy-denied` | `PROVIDER_AUTHORIZATION` | `provider_policy_denied` | Tenant governance, guardian, or platform policy, distinct from an ACL |
| `provider-throttled` | `PROVIDER_EXECUTION` | `provider_throttled` | Downstream provider quota/rate limit, with retry guidance |
| `provider-unavailable` | `PROVIDER_EXECUTION` | `provider_unavailable` | Downstream provider transient availability |
| `mutation-timeout-after-commit` | `PROVIDER_EXECUTION` | `mutation_indeterminate` | Provider mutation outcome after a disconnect; reconcile before any replay |

Fault applicability is all profiles except for two deliberate boundaries: `oauth-dynamic-registration-unsupported` applies only to `synthetic-enterprise-oauth-mcp`, because the documented enterprise profiles use manual registration; `mutation-timeout-after-commit` applies only to profiles with mutation tools and therefore excludes the read-only `microsoft-enterprise` profile.

### Live Microsoft 365 lesson represented by the fixture

On 2026-07-13, a development Microsoft 365 connection completed provider sign-in and returned to the Den API callback, then failed at token acquisition with HTTP 401, OAuth `invalid_client`, and Entra code `AADSTS7000215`. The saved tenant and client IDs matched the active app registration, but Den held a different client-secret value. Replacing the secret value and starting a fresh authorization completed the connection.

That incident proves why the lab separates authorization from token acquisition and why a plain `Token request failed with status 401` is insufficient. The Microsoft `oauth-invalid-client` fixture reproduces the safe error code and correlation shape. It does not contain the development tenant, application ID, secret, authorization code, token, or customer content, and it remains a synthetic Entra response rather than a claim of live-provider conformance.

Configuration errors, DNS, TCP, TLS, proxy/WAF behavior, and real browser consent are intentionally outside the in-process fault catalog. Test them with a bad hostname, a reserved closed port, a self-signed TLS harness, or the target enterprise network. Do not fake those failures as an HTTP response from an already-reached server; that would assign the wrong first failed phase.

## Manual UI verification

Use this short review path first:

1. Start the lab and sign in. Confirm the page says **Private loopback control plane** and shows no instances.
2. In Den, begin a manual/pre-registered OAuth connection for the planned lab endpoint, copy the callback URI Den shows, and stop before **Connect**.
3. Create an instance named `ServiceNow manager review` with profile `servicenow-inbound-quickstart`, that exact callback URI, a free data-plane port, and client secret `synthetic-client-secret-local`. Confirm it is **STOPPED**, the exact registered callback is visible, and the secret is shown only as configured.
4. Click **Start**, then **Connect** in Den. Confirm the instance is **RUNNING** and its MCP URL ends in `/sncapps/mcp-server/mcp/sn_mcp_server_default`.
5. Select `operation · PROVIDER_AUTHORIZATION · Provider ACL denied` and apply the revision. Confirm the revision increments and the explainer names the operation diagnostic level, `PROVIDER_AUTHORIZATION`, and `provider_authorization_denied`.
6. Click **Run probe**. Confirm **Expectation matched** and that expected and observed both report failure at `PROVIDER_AUTHORIZATION` with category `provider_authorization_denied`.
7. Click **Reset**. Confirm runtime evidence clears while the configured fault remains.
8. Select **Healthy baseline**, apply the next revision, and run the probe. Confirm expected and observed both report success with no failed phase or category.
9. Click **Delete**. Confirm the page returns to **No instances yet** and the data-plane port is no longer listening.

At every step, inspect the safe event timeline. It may contain phase, event, correlation ID, and request method; it must not contain the admin secret, OAuth client secret, authorization code, bearer token, session ID, request body, or tool arguments.

The control-plane browser origin and the OAuth callback are intentionally different concerns. Keep the lab UI on its literal loopback origin such as `http://127.0.0.1:8794`, but register Den's callback exactly as displayed. Microsoft Entra development registrations commonly use `http://localhost:<port>/...`; the fixture accepts that exact `localhost` callback and never rewrites it to `127.0.0.1`.

## API verification

The HTML interface and JSON API use the same control plane. The following local-only example needs `curl` and `jq`. It assumes the lab is already running and the admin secret remains in the current shell environment.

```bash
export LAB_ORIGIN=http://127.0.0.1:8794
export LAB_COOKIES="$(mktemp)"
export LAB_HTML="$(mktemp)"

curl --silent --show-error --location \
  --cookie-jar "$LAB_COOKIES" \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "adminSecret=$ENTERPRISE_MOCK_LAB_ADMIN_SECRET" \
  "$LAB_ORIGIN/session/login" > "$LAB_HTML"

export LAB_CSRF="$(sed -n 's/.*name="csrfToken" value="\([^"]*\)".*/\1/p' "$LAB_HTML" | head -n 1)"
```

Create and start a ServiceNow-style instance:

```bash
export DATA_PORT=21080
export DEN_REDIRECT_URI="http://127.0.0.1:8790/v1/mcp-connections/oauth/callback"
CREATE_RESPONSE="$(curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data "$(jq -nc --argjson port "$DATA_PORT" --arg redirectUri "$DEN_REDIRECT_URI" '{displayName:"ServiceNow API review",profileId:"servicenow-inbound-quickstart",port:$port,clientId:"synthetic-client",clientSecret:"synthetic-client-secret-local",redirectUris:[$redirectUri]}')" \
  "$LAB_ORIGIN/api/v1/instances")"

export INSTANCE_ID="$(jq -r .id <<<"$CREATE_RESPONSE")"
export REVISION="$(jq -r .scenarioRevision <<<"$CREATE_RESPONSE")"

curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/actions/start" | jq
```

Activate the provider authorization fault and prove its source:

```bash
FAULT_RESPONSE="$(curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data "$(jq -nc --argjson revision "$REVISION" '{expectedRevision:$revision,faultId:"provider-authorization-denied"}')" \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/scenario")"

export REVISION="$(jq -r .scenarioRevision <<<"$FAULT_RESPONSE")"

curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/actions/probe" \
  | jq '{matches: .lastProbe.matchesExpectation, expected: .lastProbe.expected, observed: .lastProbe.observed}'
```

The last command must return `matches: true`, with expected and observed both equal to:

```json
{
  "outcome": "failure",
  "firstFailedPhase": "PROVIDER_AUTHORIZATION",
  "category": "provider_authorization_denied"
}
```

Reset, recover healthy, and clean up:

```bash
curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/actions/reset" > /dev/null

HEALTHY_RESPONSE="$(curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data "$(jq -nc --argjson revision "$REVISION" '{expectedRevision:$revision,faultId:null}')" \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/scenario")"

curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/actions/probe" \
  | jq '{matches: .lastProbe.matchesExpectation, observed: .lastProbe.observed}'

curl --silent --show-error \
  --cookie "$LAB_COOKIES" \
  --header "Origin: $LAB_ORIGIN" \
  --header "X-CSRF-Token: $LAB_CSRF" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$LAB_ORIGIN/api/v1/instances/$INSTANCE_ID/actions/delete"

rm -f "$LAB_COOKIES" "$LAB_HTML"
```

The healthy UI probe runs in `fixture-conformance` mode. It must return `matches: true`, `outcome: success`, and `null` for both `firstFailedPhase` and `category`; it proves OAuth, MCP initialization, the exact pinned tool-name set, and schema validity, but deliberately does not execute a provider tool or compare every schema field byte-for-byte.

## Automated verification layers

No single test is allowed to stand in for all the others.

| Layer | What it proves | Command or owner |
| --- | --- | --- |
| Contract/unit | Scenario schema, profile provenance, fault applicability, revisions, redaction, deterministic state | `pnpm --filter @openwork/enterprise-mcp-mock-server test` |
| Package quality | Public TypeScript surface and distributable build | `pnpm --filter @openwork/enterprise-mcp-mock-server check` |
| Protocol integration | OAuth discovery/token path, MCP initialize/lifecycle, pagination, tool calls, JSON/SSE, exact injected failures | Package integration tests |
| Control-plane security | Loopback configuration, login/rate limit, session cookie, Origin/CSRF, write-only secrets, safe errors | `pnpm --filter @openwork-ee/enterprise-mock-lab test` |
| App build | EE app imports only the public package contract and compiles as a standalone process | `pnpm --filter @openwork-ee/enterprise-mock-lab build` |
| Standalone journey | Real lab process and browser: create, start, inject fault, match first phase, reset, recover, delete | `pnpm fraimz --flow enterprise-mock-lab --cdp-url <disposable-cdp-url>` |
| Future Den consumer | Den connects over the instance URL and renders the same phase/category without importing the lab | Separate follow-up PR and Den-specific tests |
| Live-provider conformance | Target tenant, product, patch, permissions, policy, schemas, and provider IDs match reality | Approved Microsoft/ServiceNow test tenant; never silently run by this lab |

The standalone fraimz flow launches its own lab with generated synthetic secrets and random loopback ports. It does not start Den or modify a Den connection. Use a disposable Chrome/CDP profile because the flow navigates the selected page target to the lab UI.

For example, on macOS:

```bash
export PROOF_CDP_PORT=9927
export PROOF_BROWSER_PROFILE="$(mktemp -d)"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PROOF_CDP_PORT" \
  --user-data-dir="$PROOF_BROWSER_PROFILE" \
  about:blank >/dev/null 2>&1 &
export PROOF_BROWSER_PID=$!
trap 'kill "$PROOF_BROWSER_PID" 2>/dev/null || true; rm -rf "$PROOF_BROWSER_PROFILE"' EXIT

pnpm fraimz --flow enterprise-mock-lab --cdp-url "http://127.0.0.1:$PROOF_CDP_PORT"
```

Review the generated `evals/results/<run-id>/fraimz.html`. A valid run contains separate frames for the empty private lab, running ServiceNow endpoint, matched provider-authorization failure, explicit reset, matched healthy recovery, and clean deletion.

## Extension rules for `enterprise-*`

New enterprise development packages and apps should follow these rules:

1. Use kebab-case folder and package names that state one concern, such as `enterprise-mcp-mock-server` or `enterprise-mock-lab`.
2. Put reusable, browser-safe or runtime-neutral contracts in a package; put listeners, secrets, storage, and operator UI in an app.
3. Export a small deliberate public API from the package root. Internal files are not consumer contracts.
4. Make provider behavior declarative. Every new profile/fault includes an ID, phase, category, applicability, operator action, source URL, verified date, fidelity, limitation, and positive/negative tests.
5. Preserve the first-failure rule. Do not turn OAuth, MCP, provider ACL, provider policy, throttling, and business errors into one exception.
6. Keep fixtures synthetic and deterministic. No outbound calls, copied customer records, real tenant IDs, or credentials.
7. Keep mutations approval- and idempotency-aware. A timeout after commit is indeterminate until reconciled; it is never a clean retry signal.
8. Add capabilities without changing existing defaults invisibly. Breaking scenario or profile changes require an explicit schema/profile version or dated snapshot.
9. Test the package directly, test the app boundary separately, then test the real consumer over the network contract.

## Future Den relationship

Den is the first planned consumer, not the owner of this foundation. The follow-up connection-diagnostics PR should:

- launch or target a lab data-plane endpoint in development/test setup;
- use the same public remote MCP path it uses for a customer server;
- preserve the lab's first failed phase, category, safe message, and correlation evidence;
- show a clear admin explanation instead of “failed to connect”;
- never import `ee/apps/enterprise-mock-lab` or expose the lab control plane in production;
- add Den-specific assertions without weakening the package and standalone-lab gates.

That order lets reviewers validate the test instrument first, then judge Den's diagnostic behavior against a known scenario, and finally repeat selected cases against approved provider test tenants.
