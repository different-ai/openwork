# PRD: Den API MCP Server

## Status: Draft
## Date: 2026-04-28

## Problem

OpenWork Cloud needs an MCP server for `ee/apps/den-api` so users and agents can interact with the Den control-plane API through MCP clients.

The API already has a Hono server and a generated OpenAPI document. Most existing Den API endpoints should become MCP tools, but some endpoints must remain unavailable over MCP because they are auth, admin, webhook, billing, hidden, or otherwise unsafe for agent-driven access.

Users should authenticate to the MCP server through OAuth, not static API keys. The authorization flow should let users sign in, approve MCP access, select the organization that the grant applies to when needed, and receive tokens that are explicitly identifiable as MCP tokens.

## Goals

- Host the MCP server inside the existing `ee/apps/den-api` Hono process.
- Use the existing Hono route handlers as the source of behavior instead of duplicating endpoint logic.
- Use the existing OpenAPI document as the source of truth for MCP tool generation.
- Use Better Auth's OAuth 2.1 provider plugin for MCP authentication.
- Support sign-in, consent, and organization selection for organization-scoped MCP access.
- Store and identify OAuth grants/tokens as MCP usage through resource audience, scopes, client metadata, and token claims.
- Make the MCP tool catalog auto-maintainable as API routes are added or changed.
- Provide explicit allow/deny policy for operations that should not be exposed through MCP.
- Keep MCP credentials separate from existing Den API keys.

## Non-Goals

- Creating a separate generated MCP server project.
- Using `openapi-mcp-generator` as a production dependency.
- Exposing every Den API endpoint over MCP by default without policy checks.
- Letting MCP OAuth tokens become general-purpose REST API tokens.
- Replacing existing Den web sign-in flows.
- Reworking the entire Den API route structure.

## Recommended Architecture

Use three layers:

- Better Auth OAuth provider for authorization, token issuance, dynamic client registration, consent, org selection, and JWT verification.
- `@hono/mcp` for the Hono-compatible MCP Streamable HTTP transport.
- A small OpenWork-owned OpenAPI-to-MCP adapter that builds tools from the current Den OpenAPI document and dispatches tool calls through the existing Hono app.

Target request flow:

```text
MCP client
-> discovers MCP + OAuth metadata
-> starts OAuth authorization with resource=https://api.openworklabs.com/mcp
-> user signs in through Den auth
-> user selects an organization when required
-> user consents to MCP scopes
-> client receives OAuth access token and optional refresh token
-> client calls /mcp with Authorization: Bearer <access_token>
-> /mcp verifies JWT audience, issuer, scope, token_use, and org claim
-> MCP tool call maps to an OpenAPI operation
-> adapter dispatches to existing Hono route handler
-> JSON response returns as MCP tool content
```

## Package Choices

### Use `@better-auth/oauth-provider`

The Better Auth OAuth provider plugin should be the OAuth foundation because it supports:

- OAuth 2.1 authorization-code flow with PKCE.
- Public clients for AI/MCP clients.
- Dynamic client registration.
- MCP/resource-server metadata support.
- Organization-aware post-login flow through `postLogin` and `consentReferenceId`.
- JWT access tokens and JWKS verification.
- Resource/audience validation.
- Consent, revocation, refresh tokens, and introspection endpoints.

### Use `@hono/mcp`

`@hono/mcp` should be used only as the Hono transport glue for `/mcp`.

It should not own auth policy, OpenAPI conversion, endpoint filtering, or Den-specific dispatch.

### Do Not Use `openapi-mcp-generator`

`openapi-mcp-generator` is useful as a reference but should not be used as the production solution.

Reasons:

- It generates a separate MCP proxy project.
- It does not live inside the existing Hono process.
- It would create a second lifecycle and deployment surface.
- Its auth model is upstream-env-token oriented, not Den OAuth/org-consent oriented.
- We need route-level policy and internal dispatch through our existing middleware.

## OAuth Design

### Resource and Audience

Use a dedicated MCP resource audience:

```text
https://api.openworklabs.com/mcp
```

All MCP access tokens must have this audience. `/mcp` should reject tokens without it.

### Scopes

Initial scopes:

- `openid`
- `profile`
- `email`
- `offline_access`
- `mcp:read`
- `mcp:write`

Start with coarse scopes. Keep fine-grained route permissions in the MCP exposure policy and existing Den organization permissions.

Potential later scopes:

- `mcp:workers:read`
- `mcp:workers:write`
- `mcp:org:read`
- `mcp:org:write`
- `mcp:plugins:read`
- `mcp:plugins:write`

### Token Identification

MCP-issued tokens should be identifiable by multiple signals:

- OAuth resource/audience is `https://api.openworklabs.com/mcp`.
- OAuth scopes include `mcp:*`.
- OAuth client metadata includes `{ "kind": "mcp" }` when the client is known or dynamically registered for MCP.
- OAuth consent `reference_id` is the selected organization ID for org-scoped grants.
- Custom JWT claim includes token use and org ID.

Proposed custom claims:

```json
{
  "https://openworklabs.com/token_use": "mcp",
  "https://openworklabs.com/org_id": "org_...",
  "https://openworklabs.com/resource": "https://api.openworklabs.com/mcp"
}
```

### Organization Selection

Use Better Auth OAuth provider `postLogin`, not the consent page, for organization selection.

The flow should be:

- User starts OAuth authorization from an MCP client.
- If not signed in, Better Auth redirects to Den sign-in.
- After sign-in, Better Auth checks whether requested scopes include `mcp:*`.
- If the user has multiple organizations or no active organization, redirect to `/mcp/select-organization` in Den web.
- The selection page sets the active organization through the existing Better Auth organization endpoint.
- The selection page calls `oauth2.continue({ postLogin: true })`.
- `consentReferenceId` returns the active organization ID for MCP scopes.
- Consent is stored against that organization reference.

This makes the org binding part of the OAuth grant instead of a separate MCP-only side channel.

### Consent Screen

Create a Den web consent page for MCP grants.

The page should show:

- MCP client name.
- Selected organization.
- Requested scopes.
- Plain-language capabilities.
- Approve and deny actions.

The consent page should call Better Auth's OAuth consent endpoint.

### Dynamic Client Registration

Enable dynamic registration for MCP public clients, with a conservative policy.

Initial approach:

- Allow dynamic client registration.
- Allow unauthenticated public client registration only if required by target MCP clients.
- Restrict default dynamic scopes to `openid profile email mcp:read`.
- Allow `offline_access` and `mcp:write` only when explicitly requested and approved.
- Store MCP client metadata with `kind: "mcp"`.

If unauthenticated public registration is too permissive for launch, start with pre-registered trusted clients for known MCP clients and add dynamic registration after compatibility testing.

## Den API Integration

### Auth Configuration

Update `ee/apps/den-api/src/auth.ts`:

- Add Better Auth `jwt()` plugin if required by `oauthProvider`.
- Add `oauthProvider(...)` after the existing sign-in and organization plugins.
- Configure `loginPage`, `consentPage`, `postLogin.page`, scopes, valid audiences, and custom claims.
- Add TypeID generation cases for new Better Auth OAuth models if needed.

### Database Schema

Run Better Auth schema generation or manually add OAuth provider tables to `ee/packages/den-db`.

Expected work:

- Add OAuth client table.
- Add OAuth consent table.
- Add OAuth token/verification storage required by the plugin.
- Add indexes for client ID, user ID, reference ID, token lookup, and expiry cleanup.
- Add TypeID prefixes for new OAuth models if Better Auth allows custom IDs for those models.

The current auth schema only includes user, session, account, verification, and API key tables, so OAuth provider persistence will require a migration.

### Well-Known Metadata

Expose required metadata endpoints from Den API and Den web proxy paths:

- OAuth authorization server metadata.
- OpenID configuration if `openid` is supported.
- OAuth protected resource metadata for MCP.
- JWKS endpoint for JWT verification.

The Den web `/api/auth/*` proxy currently forwards auth traffic to Den API and rewrites auth locations. Ensure well-known metadata is reachable at the paths MCP clients expect.

### MCP Endpoint

Add a module under `ee/apps/den-api/src/mcp`:

```text
src/mcp/
├── index.ts
├── auth.ts
├── catalog.ts
├── invoke.ts
├── policy.ts
└── schemas.ts
```

Responsibilities:

- `index.ts`: register `/mcp` on the Hono app.
- `auth.ts`: verify OAuth JWT access tokens for MCP.
- `catalog.ts`: convert OpenAPI operations into MCP tools.
- `invoke.ts`: dispatch tool calls to existing Hono routes.
- `policy.ts`: include/exclude OpenAPI operations.
- `schemas.ts`: map OpenAPI schemas into MCP input schemas.

Register the MCP route in `src/app.ts` after global middleware and before `notFound`.

## OpenAPI-to-MCP Tool Catalog

### Tool Naming

Use OpenAPI `operationId` as the MCP tool name.

The current Den API already creates stable operation IDs through `buildOperationId(method, path)`.

Tool names should be validated for uniqueness during startup/tests.

### Tool Description

Build descriptions from:

- OpenAPI summary.
- OpenAPI description.
- HTTP method and path.
- Tags.
- Scope requirements.

### Tool Input Shape

Use a predictable input envelope:

```json
{
  "path": {},
  "query": {},
  "body": {}
}
```

Only include sections required by the operation.

This avoids collisions between path parameters, query parameters, and JSON body fields.

### Tool Output Shape

Return JSON responses as MCP text content initially.

Later, add structured content when MCP client support is consistent.

### Catalog Refresh

Generate the catalog from the in-process OpenAPI document at startup.

No generated MCP code should be committed for each route.

Add tests that fail if exposed operations cannot be converted into valid MCP tools.

## Exposure Policy

Most existing endpoints should be exposed over MCP, but not all.

Initial exclusion rules:

- Exclude routes with `hide: true`.
- Exclude `System` routes except MCP metadata if needed.
- Exclude `Auth` routes.
- Exclude `Webhooks` routes.
- Exclude `Admin` routes.
- Exclude API key creation/deletion routes.
- Exclude billing callback/internal routes.
- Exclude endpoints that create or return credentials unless explicitly approved.

Initial inclusion tags:

- `Users`
- `Organizations`
- `Members`
- `Roles`
- `Teams`
- `Templates`
- `LLM Providers`
- `Skills`
- `Skill Hubs`
- `Workers`
- `Worker Runtime`

Add a Den-specific OpenAPI extension for explicit policy:

```ts
describeDenRoute({
  summary: "List workers",
  mcp: true,
  responses: { ... },
})
```

or directly as OpenAPI metadata:

```yaml
x-mcp: false
```

Policy precedence:

- Explicit operation-level `mcp: false` always excludes.
- Explicit operation-level `mcp: true` can include if the tag/path is not globally blocked.
- Global hard-deny categories always win.
- Hidden routes are excluded unless a future review explicitly changes that rule.

## Internal Dispatch

MCP tools should dispatch through existing Hono route handlers rather than calling business functions directly.

Preferred approach:

- Verify OAuth token at `/mcp`.
- Resolve user ID and organization ID from token claims.
- Create an internal request to the corresponding `/v1/*` route.
- Attach a signed internal principal header that only in-process code can produce.
- Update auth/session middleware to recognize the internal MCP principal and populate `user`, `session`, and organization context.
- Call `app.fetch(internalRequest, c.env)`.

Do not forward the OAuth access token as if it were a normal Den REST bearer token.

This keeps MCP credentials scoped to `/mcp` while still reusing existing route middleware and permissions.

## Security Requirements

- Require HTTPS in production.
- Require PKCE for public clients.
- Verify JWT access tokens locally where possible.
- Reject opaque tokens at `/mcp` for launch.
- Verify issuer, audience, expiry, scopes, and token-use claim.
- Verify that the org claim/reference still maps to a current membership.
- Enforce existing Den RBAC inside the invoked route.
- Never expose auth, webhook, admin, hidden, or credential-issuing routes by accident.
- Log MCP tool invocation with request ID, user ID, org ID, client ID, operation ID, status, and duration.
- Do not log raw access tokens or refresh tokens.

## Implementation Phases

### Phase 1: OAuth Provider Foundation

- Add `@better-auth/oauth-provider` dependency.
- Add any required Better Auth JWT dependency/config.
- Configure OAuth provider in `ee/apps/den-api/src/auth.ts`.
- Add OAuth provider DB schema and migrations.
- Add required well-known metadata routes.
- Verify OAuth authorize/token flow manually with a public test client.

Acceptance criteria:

- OAuth metadata is reachable.
- A public client can complete authorization code + PKCE.
- Token endpoint issues JWT access tokens for the MCP audience.
- Tokens include MCP-identifying claims.

### Phase 2: Org Selection and Consent

- Add Den web `/mcp/select-organization` page.
- Add Den web `/mcp/consent` page.
- Wire Better Auth `postLogin` for MCP scopes.
- Bind consent `reference_id` to selected org.
- Add tests for users with zero, one, and multiple organizations.

Acceptance criteria:

- A user with one org can authorize without unnecessary selection friction.
- A user with multiple orgs must choose an org.
- Token claims include the selected org ID.
- Revoking consent prevents future refresh/use.

### Phase 3: MCP Transport and Token Verification

- Add `@hono/mcp` and `@modelcontextprotocol/sdk` dependencies.
- Add `/mcp` route inside Den API.
- Verify MCP OAuth JWTs at the MCP route.
- Return useful MCP auth errors for missing, expired, or wrong-audience tokens.
- Add MCP protected resource metadata if required by clients.

Acceptance criteria:

- `/mcp` rejects unauthenticated requests.
- `/mcp` rejects non-MCP tokens.
- `/mcp` accepts a valid MCP OAuth token.

### Phase 4: OpenAPI Tool Catalog

- Build catalog from the live OpenAPI document.
- Convert operations into MCP tools using operation IDs.
- Implement initial OpenAPI schema-to-tool input conversion.
- Implement policy filtering.
- Add catalog tests.

Acceptance criteria:

- Tool names are unique and stable.
- Hidden/auth/admin/webhook routes are not exposed.
- Included operations are callable in test mode.
- Adding route metadata updates the MCP catalog without generated code changes.

### Phase 5: Internal Invocation

- Implement OpenAPI operation-to-Hono-request mapping.
- Add signed internal MCP principal support.
- Dispatch tool calls through `app.fetch`.
- Preserve request IDs and logging.
- Map HTTP errors into MCP tool errors predictably.

Acceptance criteria:

- MCP `listWorkers` calls the existing `/v1/workers` handler.
- Existing org/RBAC middleware still applies.
- MCP tokens cannot be used directly against `/v1/*` REST endpoints.

### Phase 6: Hardening and Observability

- Add audit logging for MCP authorizations and tool calls.
- Add rate limits for `/mcp` and OAuth endpoints if defaults are insufficient.
- Add token revocation tests.
- Add denied-route regression tests.
- Add documentation for connecting MCP clients.

Acceptance criteria:

- Security-sensitive routes remain excluded.
- Revoked/expired tokens fail.
- Tool invocation logs are enough to debug user reports.

## Testing Plan

- Unit test OAuth claim construction and token verification.
- Unit test MCP exposure policy.
- Unit test OpenAPI-to-tool conversion.
- Integration test OAuth flow with org selection.
- Integration test `/mcp` with valid and invalid tokens.
- Integration test selected high-value tools: list workers, get worker, list skills, list members.
- Regression test excluded routes: auth, webhooks, admin, API-key creation/deletion, hidden routes.
- Manual MCP Inspector test against local Den API.

## Open Questions

- Which MCP clients must be supported at launch, and do they require unauthenticated dynamic client registration?
- Should `mcp:write` be offered at launch or start read-only?
- Should credential-returning endpoints like worker token retrieval be excluded from MCP initially?
- Do we want OAuth grants to be visible in existing org API-key screens, or a separate connected MCP apps screen?
- Should the MCP endpoint be `/mcp` or `/v1/mcp`?
- Should Den web or Den API be the canonical issuer URL in production?

## Recommended Launch Cut

Launch with:

- OAuth authorization-code + PKCE.
- JWT-only MCP access tokens.
- Org-bound grants.
- `mcp:read` and `mcp:write` scopes.
- Conservative route exclusions.
- OpenAPI-generated tool catalog.
- Internal Hono dispatch.
- Manual testing with MCP Inspector.

Defer:

- Fine-grained per-tag scopes.
- Opaque-token introspection.
- Complex structured MCP output.
- Broad unauthenticated dynamic client registration if target clients do not require it.
