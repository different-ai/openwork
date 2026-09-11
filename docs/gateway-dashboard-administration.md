# Gateway Dashboard Administration

`gatewayDashboard` controls only organization dashboard exposure. It is stored in
`organization.metadata.capabilities.gatewayDashboard` and is off unless the
stored value is the literal JSON boolean `true`. Missing, malformed, `null`,
string `"true"`, and boolean `false` values all resolve to off.

## Backoffice

Open the Den web application's `/admin` page, select **Organizations**, search
for the organization, and use **Capabilities > Gateway dashboard** on its card.
The checkbox writes `true` or `false` for that organization only and reverts on
a failed save. This is the platform backoffice, not an organization settings page.

The caller must be a signed-in user on the platform-admin allowlist. Organization
ownership or an organization admin/super-admin role alone does not authorize
these administration routes. Dashboard viewing retains the existing organization
admin-and-above permissions; enabling this flag does not grant any role or access
to ordinary members.

## API

Use the same platform-admin authentication as the backoffice. Substitute the
target organization's actual ID in both endpoints:

```http
GET /v1/admin/organizations/:organizationId/capabilities
```

The response includes the resolved value alongside other capabilities:

```json
{"capabilities":{"installLinks":true,"mcpConnections":true,"modelsAnalytics":false,"gatewayDashboard":false}}
```

To enable:

```http
PUT /v1/admin/organizations/:organizationId/capabilities
Content-Type: application/json

{"capabilities":{"gatewayDashboard":true}}
```

To explicitly disable, send this JSON to the same PUT endpoint:

```json
{"capabilities":{"gatewayDashboard":false}}
```

To delete the stored override and return to the default (off), send:

```json
{"capabilities":{"gatewayDashboard":null}}
```

PUT is a partial update: omitted capability keys retain their existing boolean
overrides. Unrelated organization metadata and unmanaged capability keys are
preserved; retired rollout keys are removed by the existing capabilities writer.
`null` deletes the managed key rather than preserving its old value as unmanaged
metadata. Strings and numbers are rejected for this input. GET and PUT responses
report effective booleans, so an absent override and explicit `false` both appear
as `false`.

The active organization's `GET /v1/org` response exposes the resolved boolean at
`capabilities.gatewayDashboard`. It is independent of `modelsAnalytics` and the
`orgManagedDashboards` protocol capability.

## Deployment

Deploy the Den API support first, before deploying or using the new backoffice
toggle and dashboard consumer. Older APIs can ignore unknown capability input;
a successful PUT against an older API is not proof the flag was stored. Verify
the new field through GET before enabling organizations.

Reload the organization's dashboard after an update. There is no live push or
automatic invalidation of an already loaded dashboard when a platform admin
changes this flag. No database migration is required.

Inference execution, member provisioning, provider synchronization, and their
backend endpoints and authorization remain intentionally unaffected. Hiding the
dashboard is not a backend inference kill switch or a replacement for API access
controls.

## Exposure and Administration Boundary

When disabled, Gateway is absent from Models navigation, command-palette search
and recent entries, and BYOK migration controls. Direct list, create, detail,
and edit URLs redirect to `/dashboard` without mounting Gateway screens or
starting their data requests. Loading, errors, and organization transitions do
not grant access; the next organization's context must be verified first.
OpenWork Models and Bring Your Own Keys keep their existing behavior.

The strict Den creation/settings APIs do not accept capability metadata. The
Better Auth organization-creation hook also rejects any explicit
`metadata.capabilities.gatewayDashboard` input, and its update hook rejects
metadata replacement. Ordinary members cannot self-enable the dashboard by
creating an organization with an override.

A separate backend rollout control would only be advisable if the intended
rollout must also restrict provider creation through direct API clients or stop
inference execution. That requires a distinct product/security decision about
existing providers and credentials; do not reuse this dashboard flag as a broad
runtime kill switch.
