# Den API style guide

This page records the conventions the Den API (`ee/apps/den-api`) follows and
how each one is enforced. The published contract is
`packages/docs/openapi.json`, generated from `describeRoute()` metadata and Zod
schemas by `pnpm api:snapshot`; `pnpm api:lint` runs the Spectral ruleset in
`.spectral.yaml`, and the **API Contract** workflow runs both on every pull
request that touches the API.

The document is also consumed at runtime: `src/mcp/catalog.ts` derives the MCP
`search_capabilities` catalog from it, so summaries, descriptions, tags and
request schemas are user-facing text for agents, not just for Swagger.

## How the gate works

| Check | Where | Fails the build when |
|---|---|---|
| Snapshot drift | `.github/workflows/api-contract.yml` | `pnpm api:snapshot` changes `packages/docs/openapi.json` |
| Spectral errors | `pnpm api:lint` (`scripts/api-lint.mjs`) | any rule at `error` severity fires |
| Warning ratchet | `pnpm api:lint` | the warning count exceeds `.spectral-baseline.json` |

When you remove warnings, lower the baseline with `pnpm api:lint --update-baseline`
and commit the file. When a finding is a deliberate exception, add it to the
`overrides` block of `.spectral.yaml` with a comment saying why; never raise
the baseline to absorb new findings.

Spectral's JSON output is written to `tmp/spectral-report.json` locally and
uploaded as the `spectral-report` artifact in CI, so counts per rule are
diffable between runs.

## Conventions

### Every route is described

Every `app.get/post/...` registration carries a `describeRoute()` with
`summary`, `tags`, `security` and `responses`. Routes without one still appear
in the document (the generator uses `includeEmptyPaths`) and are caught by
`ow-operation-security` (error) and `operation-tags` (error).

- Tags must be registered in the root `tags[]` of `src/app.ts`
  (`operation-tag-defined`, error). One tag per resource family; protocol
  adapters use their protocol name (`SCIM`, `OAuth`).
- Add a `description` when the summary does not make the behaviour obvious
  (`operation-description`, warn).
- Operations tagged `Internal` (Automation runner protocol, development-only
  email outbox) stay in the served `/openapi.json` but are removed from the
  published snapshot by `scripts/generate-openapi-snapshot.ts`.

### Security is explicit

The document declares `security: [{ bearerAuth: [] }, { denApiKey: [] }]` at
the top level and the generator copies it onto every operation that declares
none, so the two stay equivalent. A route that differs from the default says so
in its `describeRoute()`:

| Route kind (marker in `src/middleware/route-access.ts`) | `security` |
|---|---|
| `publicRoute`, `signedWebhookRoute` | `[]` (webhooks verify a signature in the handler) |
| `userSessionRoute()` | `[{ bearerAuth: [] }]` (API keys are refused) |
| `cloudTransportRoute()` | `[{ mcpAccessToken: [] }]` |
| SCIM provisioning (`tokenRoute`) | `[{ scimBearerToken: [] }]` |
| Automation runner (`tokenRoute`) | `[{ automationRunnerToken: [] }]` |
| Worker heartbeat (`tokenRoute`) | `[{ workerHeartbeatToken: [] }]` |
| `authenticatedRoute()`, `orgMemberRoute()`, `orgRoleRoute()`, `adminRoute()` | inherit the default |

Enforced by `ow-operation-security` (error). The runtime guards themselves are
covered by `test/route-guard-policy.test.ts` and
`test/route-access-policy.test.ts`; the OpenAPI declaration must describe them,
never replace them.

### Responses

- Document every status the handler and its guards can produce. Protected
  operations document at least one 4xx (`ow-operation-has-4xx`, error): `401`
  from the auth guards, `404 organization_not_found` from the organization
  guard, `400 invalid_request` from validators, `403` from role checks.
- A `200` has a body. Use `204` when there is none (`ow-200-has-content`,
  warn).
- Reuse the shared response helpers and error schemas in `src/openapi.ts`
  (`jsonResponse`, `emptyResponse`, `invalidRequestSchema`,
  `unauthorizedSchema`, `forbiddenSchema`, `notFoundSchema`,
  `enterprisePlanRequiredSchema`). Do not invent new error codes for a
  documentation change.

### Error envelope

Errors are JSON objects with a stable `error` code and an optional
human-readable `message`; validation failures add `details[]`
(`InvalidRequestError`). Codes are snake_case string constants
(`unauthorized`, `forbidden`, `organization_not_found`, `version_conflict`).
Prefer `z.literal`/`z.enum` codes over free-form strings so clients can switch
on them.

### Naming

- Paths are lowercase kebab-case nouns under `/v1`, one segment per resource:
  `/v1/desktop-policies/{desktopPolicyId}`. Name path parameters after the
  resource (`{pluginId}`), not bare `{id}`.
- Properties are camelCase. Identifiers are Den TypeIDs (`plg_...`) declared
  with `denTypeIdSchema`.
- Lifecycle fields are named `state`; `status` is reserved for HTTP-ish
  outcomes of a single operation. (The API is not yet consistent here; see
  follow-ups.)

### Timestamps

Timestamps end in `At` and are RFC 3339 `string` / `format: date-time`
(`createdAt`, `expiresAt`). Nullable timestamps are `anyOf [date-time, null]`.
Enforced by `ow-timestamps-date-time` (warn). Epoch-millisecond integers still
exist in the Automation schemas; they are counted in the baseline and tracked
as a follow-up rather than changed on the wire.

### Pagination

Collections are paginated with cursor + limit and return `items[]` and
`nextCursor` (`null` on the last page):

```
GET /v1/automations?cursor=...&limit=50
{ "items": [...], "nextCursor": "..." }
```

`limit` is an integer with a documented maximum. Enforced by
`ow-list-pagination` (warn) for GETs that accept `limit`/`offset` or return
`items`. Offset lists (admin pages) and limit-only lists are counted in the
baseline and tracked as follow-ups.

### Updates

- `PATCH` performs a partial update; omitted fields are unchanged and an
  explicit `null` clears a nullable field.
- `PUT` replaces a whole sub-resource or setting (for example an
  organization's capability overrides).
- Actions that are not a plain state change use `POST /{resource}/{verb}`
  (`/retire`, `/activate`, `/disconnect`).
- Server-set fields (`id`, `organizationId`, `createdAt`, `updatedAt`) are not
  accepted on input.

### Deprecation

A removed route keeps its path and answers `410` with
`{ "error": "deprecated", "message": ... }`, is tagged `Deprecated`, and
carries `deprecated: true` in the document. Tombstones are the only operations
allowed to have no 2xx response (`operation-success-response` is turned off
for them in `.spectral.yaml`). Removing a route inside `v1` is a breaking
change; do it only with a documented notice period.

## Protocol adapters

SCIM 2.0 (`/api/auth/scim/v2/**`), OAuth 2.0 / OpenID Connect discovery and
registration (`/.well-known/**`, `/register`, `/api/auth/oauth2/*`) and MCP
protected-resource metadata implement their RFCs verbatim (RFC 7643/7644,
RFC 8414, RFC 7591, RFC 9728, OpenID Connect Discovery 1.0). For them:

- Field names, casing, paging (`startIndex`/`count`) and error shapes follow
  the RFC, not this guide.
- They live under their own prefix and are tagged by protocol (`SCIM`,
  `OAuth`), never mixed into resource tags.
- They are exempt from `ow-list-pagination`, `ow-timestamps-date-time` and
  (for the public discovery documents) `ow-operation-has-4xx` through the
  `overrides` block in `.spectral.yaml`.
- They still require `security`, `summary`, `tags` and `responses` like every
  other operation. SCIM responses use `application/scim+json`
  (`scimJsonResponse` in `src/openapi.ts`).

## Documented exceptions

| Exception | Reason | Where |
|---|---|---|
| `/health`, `/ready` have no 4xx | liveness probes answer with status codes only | `.spectral.yaml` overrides |
| Deprecated `/v1/skill-hubs*` and `POST /v1/memory` answer only `410` | intentional tombstones | `.spectral.yaml` overrides |
| `DELETE /v1/memory/{id}` answers only `401`/`404` | listed with the tombstones; whether it should also document a 2xx is an open follow-up | `.spectral.yaml` overrides |
| `array-items` is a warning, not an error | the two `prefixItems` tuples are valid OpenAPI 3.1 | `.spectral.yaml` rules |
| `Internal` operations are absent from the snapshot | runner protocol and dev outbox are not a third-party surface | `scripts/generate-openapi-snapshot.ts` |

## Follow-ups (not enforced yet)

These are known deviations counted in the warning baseline or out of the
linter's reach. Each is a wire or schema change and needs its own change with
a compatibility plan:

- One timestamp encoding (epoch-ms integers in Automation schemas).
- One pagination model (offset admin pages; limit-only `/v1/workflow-runs`,
  `/v1/workflows/{id}/snapshots`, `/v1/workers`; `limit` typed as string).
- Typed path parameters instead of bare `{id}`.
- Static-vs-parameter path pairs (`/versions/latest`, `/workflows/test`,
  `/plugins/import-mcps-from-github-url`, `/mcp-connections/*`).
- PATCH/PUT policy on `POST /v1/members/{memberId}/role` and
  `POST /v1/cloud/instance/update`.
- `state` vs `status` naming.
- `readOnly` on server-set fields; ETag / idempotency keys; examples.
- Response arrays and enums that should be required.
- 25 unused component schemas.
- `410` tombstones inside `v1` and `DELETE /v1/memory/{id}`.
- `200` responses that need a real body schema.
