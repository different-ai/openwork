# SSO for Den API

## Goal

Add self-serve enterprise SSO to Den so each OpenWork organization can configure its own SAML or OIDC provider, expose an organization-specific sign-in URL, and keep SSO identity state aligned with SCIM provisioning state.

The intended product model is:

- each organization owns its SSO configuration
- each organization can have a dedicated SSO sign-in URL
- SSO sign-in can add users to the organization
- SCIM remains the source of truth for remote identity and lifecycle when enabled
- SSO and SCIM share the same remote identity mapping where possible

## Short Answer

Better Auth's SSO plugin appears suitable for per-org SSO as a foundation.

It explicitly supports:

- registering OIDC and SAML providers
- linking an SSO provider to `organizationId`
- signing in by `organizationSlug`
- organization provisioning on SSO sign-in
- custom user provisioning via `provisionUser`
- running provisioning on every login via `provisionUserOnEveryLogin`
- provider-specific callback URLs and optional shared OIDC redirect URI

But Den should still own the product surface and lifecycle policy.

Do not expose raw Better Auth SSO registration directly to org admins. Instead, build Den routes that validate org access, generate internal provider ids, store only safe metadata in Den-facing responses, and call Better Auth APIs behind the scenes.

## Better Auth SSO Fit

### Good fit

The plugin has the exact primitive Den needs for org-scoped SSO:

```ts
await auth.api.registerSSOProvider({
  body: {
    providerId: "acme-corp-saml",
    issuer: "https://acme-corp.okta.com",
    domain: "acmecorp.com",
    organizationId: "org_acme_corp_id",
    samlConfig: {},
  },
  headers,
})
```

And sign-in can target an organization directly:

```ts
await auth.api.signInSSO({
  body: {
    organizationSlug: "acme",
    callbackURL: "/dashboard",
  },
})
```

That means Den can create URLs like:

- `/sso/acme`
- `/o/acme/sso`
- `/api/auth/sign-in/sso` with `organizationSlug=acme`

The user-facing URL can be Den-owned while Better Auth handles protocol redirects under `/api/auth/sso/...`.

### Partial fit

Better Auth's organization provisioning can add SSO-authenticated users to the linked organization. That is useful, but it is not enough by itself.

Den still needs policy for:

- whether an SSO login can create a new global app user
- whether an SSO login can link to an existing email user
- whether SSO can update the global user name/email/image
- how SSO attributes map to org role/team membership
- how SSO identity should sync with SCIM identity

### Risk areas

The SSO plugin stores provider configuration in `ssoProvider`, including JSON SAML/OIDC config. Some values are secrets or sensitive configuration. Den should avoid returning raw provider config to the browser.

OIDC discovery also depends on `trustedOrigins`. For self-serve SSO, Den needs a controlled way to trust known IdP origins during registration. A global wildcard is not acceptable.

## Recommended Product Shape

### Admin routes

Add active-org routes similar to SCIM:

- `GET /v1/sso`
- `POST /v1/sso/oidc`
- `POST /v1/sso/saml`
- `PATCH /v1/sso`
- `DELETE /v1/sso`
- `GET /v1/sso/metadata?format=xml`
- `POST /v1/sso/verify-domain`

Access policy:

- owner/admin only
- route uses active organization context
- provider id is generated server-side
- raw Better Auth management routes should not be the public product API

### Public sign-in routes

Add stable Den-owned routes:

- `GET /sso/:orgSlug`
- `GET /login/sso/:orgSlug`
- optionally `POST /v1/auth/sso/start`

Behavior:

1. Resolve organization by slug.
2. Confirm the org has an enabled SSO provider.
3. Call `auth.api.signInSSO` with `organizationSlug` or provider id.
4. Pass a Den callback URL such as `/o/:orgSlug/dashboard`.
5. Redirect the browser to the IdP.

This gives every org a dedicated sign-in URL while keeping Better Auth's protocol callback endpoints unchanged.

### Callback routes

Better Auth owns protocol callbacks:

- OIDC: `/api/auth/sso/callback/:providerId` or shared `/api/auth/sso/callback`
- SAML: `/api/auth/sso/saml2/callback/:providerId`
- SAML SP metadata: `/api/auth/sso/saml2/sp/metadata?providerId=...`

Den can wrap metadata access with an org route, but the IdP should ultimately point at Better Auth-compatible ACS/callback URLs.

## Provider ID Policy

Provider ids are global in Better Auth. Den should never let admins choose the raw provider id.

Use deterministic internal ids:

- SSO: `openwork-sso-${organizationId}`
- SCIM: `openwork-scim-${organizationId}`

If multiple SSO providers per org become necessary, use:

- `openwork-sso-${organizationId}-${connectionId}`

Initial recommendation:

- one active SSO provider per organization
- one active SCIM provider per organization
- support replacing/rotating configuration, not multiple active providers

## Data Model

### Better Auth table

The SSO plugin requires an `ssoProvider` table with fields like:

- `id`
- `issuer`
- `domain`
- `oidcConfig`
- `samlConfig`
- `userId`
- `providerId`
- `organizationId`
- optional `domainVerified`

Den can use this as the protocol configuration source.

### Den metadata table

Add a Den-owned table for safe org-facing metadata.

Proposed table: `sso_connection`

- `id`: Den TypeID, e.g. `sso_...`
- `organizationId`
- `providerId`
- `kind`: `oidc` or `saml`
- `issuer`
- `domain`
- `status`: `draft`, `enabled`, `disabled`, `error`
- `signInPath`: e.g. `/sso/acme`
- `lastTestedAt`
- `lastError`
- `createdAt`
- `updatedAt`

This table avoids having Den web parse or expose sensitive Better Auth provider config.

### Shared identity table

Reuse or expand the proposed SCIM identity mapping rather than creating an entirely separate SSO identity silo.

Rename candidate: `external_identity`

- `id`: Den TypeID, e.g. `xid_...`
- `organizationId`
- `userId`
- `source`: `scim`, `sso`, or `scim+sso`
- `scimProviderId`
- `ssoProviderId`
- `remoteId`: IdP subject, SAML NameID, or SCIM external remote id
- `externalId`: SCIM `externalId` when present
- `userName`: SCIM `userName` or SSO preferred username
- `email`
- `displayName`
- `nameJson`
- `emailsJson`
- `attributesJson`
- `active`
- `lastScimSyncAt`
- `lastSsoLoginAt`
- `createdAt`
- `updatedAt`

If we keep the name `scim_identity`, SSO still needs an equivalent `sso_identity` and a linking policy. A single `external_identity` table is cleaner for a combined SSO + SCIM enterprise identity model.

## SSO and SCIM Relationship

SSO and SCIM solve different problems:

- SSO authenticates a human at login time.
- SCIM provisions and deprovisions identity and group membership out-of-band.

They should cooperate, but SCIM should generally be the lifecycle source of truth when enabled.

### If only SSO is enabled

On SSO login:

1. Resolve SSO provider by org slug/provider id/domain.
2. Better Auth authenticates the user.
3. Den provisioning records an `external_identity` with `source = "sso"`.
4. Den adds org membership using SSO org provisioning.
5. Den may assign role from SSO attributes if configured.

This is just-in-time provisioning.

### If only SCIM is enabled

SCIM creates and manages users before login.

Login may still happen through email/social/passwordless unless org policy requires SSO.

### If both SSO and SCIM are enabled

Recommended policy:

1. SCIM owns active/inactive lifecycle and group/team membership.
2. SSO owns authentication and last-login profile refresh.
3. SSO login should link to an existing SCIM identity using a stable remote identifier first, then verified email as fallback.
4. SSO should not reactivate a SCIM-deactivated identity unless org policy explicitly allows it.

Link order:

1. Match `(organizationId, ssoProviderId, remoteId)` where remoteId is OIDC `sub` or SAML NameID.
2. Match `(organizationId, scimProviderId, externalId)` if the SSO subject maps to the SCIM external id.
3. Match verified email in the same organization if domain and provider are trusted.
4. Otherwise create a new external identity only if just-in-time provisioning is enabled.

## Attribute Sync

### SSO attributes

SSO can provide:

- OIDC `sub`
- OIDC `email`
- OIDC `email_verified`
- OIDC `name`
- OIDC `picture`
- SAML `nameID`
- SAML mapped attributes like `department`, `role`, `groups`

Store these in `external_identity.attributesJson` and update `lastSsoLoginAt`.

### SCIM attributes

SCIM can provide:

- `externalId`
- `userName`
- `name`
- `displayName`
- `emails`
- `active`
- group membership

Store these in the same identity record and update `lastScimSyncAt`.

### Conflict policy

If both SSO and SCIM provide the same attribute:

- lifecycle active/inactive: SCIM wins
- org membership: SCIM wins if SCIM is enabled
- team/group membership: SCIM wins if group sync is enabled
- display name/email: default to SCIM if present, otherwise SSO
- last login profile hints: SSO can update non-authoritative display fields only if allowed

## Organization Sign-In URL

Each org should have a stable sign-in URL:

```text
https://app.openworklabs.com/sso/:orgSlug
```

The route should render a minimal page or immediately redirect.

Recommended behavior:

- if exactly one enabled SSO connection exists: start SSO immediately
- if SSO is not configured: show a helpful error and fallback login link
- if org requires SSO: hide password/social fallback for that org
- if user enters email on generic login: resolve SSO by domain and route to the org SSO flow when unambiguous

For enterprise IT setup, the admin page should display:

- sign-in URL
- SAML ACS URL
- SAML SP metadata URL
- OIDC redirect URL
- entity ID / audience
- current status
- domain verification state if enabled

## Trusted Origins for OIDC Discovery

The SSO plugin validates OIDC discovery URLs against Better Auth `trustedOrigins`.

Den should not add `*` just to support self-serve OIDC.

Recommended approach:

1. Keep normal app trusted origins as-is.
2. Add a dynamic trusted origin callback for SSO registration only.
3. For self-serve setup, require org admins to submit issuer URL first.
4. Validate issuer host against an allowlist policy or explicit org-scoped pending configuration.
5. Perform discovery server-side and store success/failure status.

Open question:

- whether Better Auth's `trustedOrigins` callback can read enough request/body context for Den's per-org issuer trust. If not, Den may need to pre-validate OIDC discovery before calling `registerSSOProvider`, or maintain a controlled global list of known enterprise IdP origins.

## Domain Verification

Better Auth can verify provider domain ownership via DNS TXT records.

Recommendation:

- enable domain verification for production self-serve SSO
- expose verification token and status in Den admin UI
- require verified domain before automatic account linking by email

This is especially important because SSO account linking can attach an existing app user to an enterprise org.

## Security Defaults

Recommended SAML settings for production:

- `enableInResponseToValidation: true`
- `allowIdpInitiated: true` initially for enterprise compatibility, with org-level option to disable
- `requireTimestamps: true` for strict enterprise deployments after testing
- `algorithms.onDeprecated: "reject"` for production, or `warn` during rollout
- keep default replay protection enabled
- enforce request/body size limits at infrastructure and app layers

Recommended account-linking policy:

- do not trust unverified domains for automatic account linking
- prefer remote stable identifiers over email matching
- require explicit admin policy for linking existing global users into an org

## Implementation Plan

### Phase 1: research and schema

1. Add `@better-auth/sso`.
2. Add `ssoProvider` schema and Den `sso_connection` metadata table.
3. Add TypeID prefix for SSO connection if needed.
4. Decide whether to rename `scim_identity` to `external_identity` before building the compatibility layer.

### Phase 2: server integration

1. Enable `sso()` in `ee/apps/den-api/src/auth.ts`.
2. Configure `organizationProvisioning.disabled = false`.
3. Configure `provisionUserOnEveryLogin = true`.
4. Implement `provisionUser` to upsert `external_identity` and audit SSO login.
5. Add Den-owned org admin routes under `/v1/sso`.
6. Add Den-owned sign-in start route for `/sso/:orgSlug`.

### Phase 3: admin UI

1. Add SSO page to org dashboard.
2. Support SAML config input first, since enterprise SSO is usually SAML.
3. Add OIDC config with issuer discovery after trusted-origin policy is settled.
4. Display generated IdP setup values and org sign-in URL.
5. Show connection health and last error.

### Phase 4: SCIM sync

1. Add shared `external_identity` table or link `sso_identity` to `scim_identity`.
2. Link SSO logins to SCIM-provisioned identities by remote id / external id / verified email.
3. Enforce SCIM deactivation on SSO sign-in.
4. Sync SSO attributes only where SCIM is not authoritative.
5. Add optional SSO group claim to team mapping only if SCIM group sync is not enabled.

### Phase 5: hardening

1. Add audit logs for provider registration, update, delete, sign-in, and failed sign-in.
2. Add test IdP fixtures for SAML and OIDC.
3. Add end-to-end tests for org-specific sign-in URL.
4. Add docs for Okta, Google Workspace, Microsoft Entra, and OneLogin setup.

## Open Questions

1. Should an org support more than one active SSO provider?
2. Should org admins be allowed to require SSO for all members of their domain?
3. Should IdP-initiated SAML be allowed by default?
4. Should SSO be able to create users when SCIM is enabled, or should SCIM pre-provisioning be required?
5. Should SCIM and SSO share one `external_identity` table from the start?
6. How should Den safely support arbitrary OIDC issuer discovery without weakening global trusted origins?

## Proposed Decision

Use Better Auth SSO for protocol handling and provider storage, but wrap it with Den-owned org routes and identity sync policy.

Proceed with:

- one SSO provider per org initially
- Den-generated provider ids
- Den-owned `/v1/sso` admin API
- Den-owned `/sso/:orgSlug` sign-in URL
- Better Auth protocol callbacks under `/api/auth/sso/...`
- shared `external_identity` planning with SCIM
- SCIM authoritative lifecycle when both SSO and SCIM are enabled

This fits the desired per-org SSO model and aligns with the SCIM compatibility-layer direction.
