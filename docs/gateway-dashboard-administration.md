# Gateway Dashboard Administration

Gateway is generally available to admins and above in every organization when
Gateway is configured on the deployment. New organizations need no opt-in or
platform-admin grant. There is no organization Gateway flag or API toggle.

## Deployment and organization administration

The deployment operator still configures `GATEWAY_ENABLED=true` on Den API and
Gateway, or `gateway.enabled: true` with Helm, using matching release images and
validated database, encryption, and internal/public origin settings. The
active organization's authenticated `GET /v1/org` response advertises the
independent top-level contract:

```json
{"deploymentCapabilities":{"version":1,"aiGateway":true}}
```

`GATEWAY_ENABLED` and `deploymentCapabilities.aiGateway` remain installation
configuration checks, not organization rollout flags. Missing, malformed, or
unsupported deployment capability responses fail closed. A healthy process or
an organization metadata value is not proof of deployment support.

Once configured, sign in as an organization owner, super-admin, or admin and open
Gateway. Regular members do not gain shared credential administration. Gateway
management APIs retain organization-admin permissions, tenant isolation, and
fresh authentication for privileged writes. Loading, errors, and organization
transitions do not grant access; the selected organization's context must be
verified before mounting management screens or starting their requests.

Platform backoffice routes remain restricted to signed-in users on the
platform-admin allowlist. Organization ownership or an organization admin role
does not authorize those routes. They are not needed to enable Gateway for an
organization, and the backoffice no longer offers a Gateway dashboard toggle.

## Deprecated wire compatibility

For older clients, the active organization's `GET /v1/org` and the platform-admin
capability GET/PUT responses retain `capabilities.gatewayDashboard` as constant
`true`. This is a deprecated compatibility field, **not a real feature flag**,
not a deployment-readiness signal, and not an authorization decision. It remains
`true` even when deployment configuration disables Gateway management. Do not
use it instead of the deployment contract or organization role checks.

The existing platform-admin
`PUT /v1/admin/organizations/:organizationId/capabilities` endpoint still accepts
`gatewayDashboard` boolean or null input as a deprecated no-op. Sending `true`,
`false`, or `null` cannot enable, disable, or restrict Gateway. Other capability
keys keep their existing partial-update semantics and authorization rules.

Previously stored `organization.metadata.capabilities.gatewayDashboard` values,
including explicit `false`, are ignored. No database migration or backfill is
required for this retirement; do not write a replacement organization capability.
This does not waive the schema migrations required by a Gateway release.

## Security and recovery boundaries

Ordinary organization creation/settings APIs are not a way to assign managed
capabilities. Metadata updates cannot grant deployment support or organization
roles. Authentication, role checks, fresh sessions, provider access grants,
credential isolation, and key revocation remain separate controls.

To stop new Gateway management admission, use deployment configuration rather
than the retired organization field. This is not a runtime inference kill switch:
member provisioning, usable/connect/OAuth/revocation paths, provider
synchronization, and runtime authorization retain their existing behavior.
Disabling management does not revoke keys or cancel billing. Removing the Helm
component can interrupt traffic and is a different operation.

OpenWork Models billing, subscriptions, keys, and legacy contracts are unchanged.
Follow the current [Gateway deployment guide](../packages/docs/self-host/gateway.mdx)
and [safe upgrade and disable guide](../packages/docs/self-host/gateway-upgrade.mdx)
for installation configuration, schema cutover, secret handling, and recovery.
