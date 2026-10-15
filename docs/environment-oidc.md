# Self-hosted installation OIDC

Den API can register one installation-wide OpenID Connect identity provider at
startup, with discovery deferred until the first sign-in. This is an alternative
to Google/GitHub login, not a replacement for
organization-managed SSO. It requires a standard authorization-code OIDC provider
that issues signed ID tokens with `sub`, `email`, `email_verified: true`, and
`nonce`. OAuth-only providers and unsigned proxy identity headers are not accepted.

## Configure

Set these variables on **den-api only**; Den web reads public provider metadata
from the API, so no client secret or issuer needs to be copied to the frontend.

```dotenv
DEN_DEPLOYMENT=self_hosted
DEN_FEATURE_ENVIRONMENT_OIDC=true
OIDC_CLIENT_ID=openwork
OIDC_CLIENT_SECRET=<inject from your secret manager>
OIDC_ISSUER_URL=https://identity.example.com/realms/work
OIDC_PROVIDER_NAME=Company sign-in
```

`environmentOidc` is off by default and only exists on self-hosted installations.
`DEN_FEATURE_ENVIRONMENT_OIDC=true` is an operator lock, also available as Helm
`config.features.environmentOidc: "true"`. Alternatively roll it out for everyone
through `/admin` after configuring credentials. Organization overrides do not
enable an installation-wide signed-out login method. The admin kill switch still
wins over the operator lock: new sign-ins, callbacks, and account linking are
refused; existing sessions remain valid. Disabling this login method is not
session revocation. Keep an organization SSO or local recovery account available
before changing the rollout or rotating provider configuration.

Register this exact redirect URI with the IdP (replace the origin with
`BETTER_AUTH_URL`, normally the public Den web origin):

```text
https://openwork.example.com/api/auth/callback/env-oidc-oidc
```

The final segment is `env-oidc-` followed by `OIDC_PROVIDER_ID` (default `oidc`).
The prefix isolates installation accounts from built-in and organization SSO
providers. Keep the issuer, provider ID and subject mapping stable: changing
them changes identity, not just a button label. Changing the provider ID also
requires updating the registered redirect URI.

| Variable | Default | Notes |
| --- | --- | --- |
| `OIDC_CLIENT_ID` | unset | Required together with client secret and issuer. |
| `OIDC_CLIENT_SECRET` | unset | Confidential client secret; use container/Kubernetes secrets. |
| `OIDC_ISSUER_URL` | unset | Exact issuer, including tenant/realm path and trailing slash if published. |
| `OIDC_PROVIDER_ID` | `oidc` | Lowercase identifier, max 48 characters. Stored as `env-oidc-<id>`. |
| `OIDC_PROVIDER_NAME` | `SSO` | Plain text, max 80 characters. Button: “Continue with …”. |
| `OIDC_SCOPES` | `openid,email,profile` | Comma- or space-separated; `openid` and `email` required. |
| `OIDC_PKCE` | `true` | S256. Set false only for a legacy provider that rejects PKCE. Nonce/state remain mandatory. |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` | Also accepts `client_secret_post`. |
| `OIDC_AUTHORIZATION_ENDPOINT` | discovered | Explicit mode requires all three endpoint overrides below. |
| `OIDC_TOKEN_ENDPOINT` | discovered | Token endpoint. |
| `OIDC_JWKS_ENDPOINT` | discovered | Public signing-key endpoint. |

Discovery uses `<issuer-without-final-slash>/.well-known/openid-configuration`.
Its `issuer` must exactly equal `OIDC_ISSUER_URL`. Authorization, token and JWKS
URLs and supported asymmetric signing algorithms are required; discovery errors
refuse that provider's authentication rather than downgrading token verification.
Discovery is lazy and bounded; an unreachable optional IdP cannot prevent other
login methods or existing sessions from working. Metadata is cached per API
process, and a failed discovery can be retried on the next sign-in.
Explicit endpoint mode skips discovery but still verifies issuer, audience,
signature, expiration and request-bound nonce. RS256, PS256, ES256 and EdDSA are
supported. All endpoints require HTTPS; loopback HTTP is accepted only with
`OPENWORK_DEV_MODE=1`. Internal HTTPS IdPs are allowed because this configuration
is operator-controlled. For private CAs, use the installation's Node trust-store
configuration; never disable certificate verification.

No `OIDC_ENABLED` switch is needed: credentials configure the provider and the
feature registry controls availability. `OIDC_USERINFO_ENDPOINT` is not used:
identity and verified email must come from the signed ID token. Configure the
IdP to emit those claims (including verification) for this client. For Entra ID,
use a tenant-specific issuer, not a multi-tenant `common` issuer, and ensure it
emits a trustworthy verified-email claim; do not assume a UPN is a verified email.
Cloudflare Access must expose a standard OIDC authorization-code application;
putting a reverse proxy in front of Den alone does not authenticate a Den session.

## Zero-touch single-organization bootstrap

Keep public password signup disabled and declare the initial owner separately:

```dotenv
DEN_ORG_MODE=single_org
DEN_SINGLE_ORG_NAME=OpenWork
DEN_SINGLE_ORG_SLUG=default
DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=false
DEN_SINGLE_ORG_OWNER_EMAILS=owner@example.com
```

The verified OIDC owner can create the initial organization through normal
single-organization session provisioning without a password or DNS challenge.
Restrict who can use the application at the IdP. The installation provider is
trusted to authenticate users, **not** to assign roles, groups, permissions,
organization memberships outside normal singleton provisioning, or platform-admin
access. Preserve explicit owner allowlists on unattended installations.

## Identity and policy boundaries

- Every callback must present a signed, unexpired, issuer/audience/nonce-bound ID
  token and literal boolean `email_verified: true`. No userinfo or access-token
  fallback can turn an unverified email into an account.
- A matching, already verified local account may link through Better Auth's normal
  policy; an unverified local account cannot be claimed. The provider is never
  added to a trusted-provider override. Existing subject logins reuse the account;
  changing a linked subject's email requires an explicit local profile update.
- Organization SSO requirements, verified SSO email domains and single-organization
  SSO configuration take precedence. An installation provider does not bypass
  DNS verification, SSO tests, SCIM deprovisioning, or allowed-email-domain checks.
- Allowed singleton email domains are checked before account creation/linking,
  even when public email signup is disabled. Neither OIDC nor an IdP-issued role
  claim broadens that allowlist.
- The login button may remain visible in an already-open tab after a rollout
  changes; server-side checks still refuse the flow before account mutation.

## Helm and containers

The chart's existing `denApi.env` accepts ordinary values and `valueFrom` secret
references; no second configuration path is necessary:

```yaml
config:
  features:
    environmentOidc: "true"
  tenancy:
    ownerEmails: owner@example.com

denApi:
  env:
    OIDC_ISSUER_URL: https://identity.example.com/realms/work
    OIDC_CLIENT_ID: openwork
    OIDC_PROVIDER_NAME: Company sign-in
    OIDC_CLIENT_SECRET:
      valueFrom:
        secretKeyRef:
          name: openwork-oidc
          key: client-secret
```

Docker Compose/ECS/Kubernetes can inject the same environment variables directly
into den-api. Configure secrets outside source control and do not put client
secrets in Helm ConfigMaps, browser variables, URLs, screenshots or diagnostic
logs. Restart API replicas when changing provider metadata or credentials.

## Runtime ownership

Den API owns startup configuration, discovery, policy and session/account
persistence. Better Auth owns authorization code, state, S256 PKCE and nonce
handling and JWT verification. Den web only requests public `{ id, name }`
metadata from `GET /v1/auth/environment-oidc` and starts the existing social-login
flow, preserving its callback/resume behavior. Organization SSO remains the
separate, database-backed `/v1/sso` lifecycle. No worker or OpenCode authentication
path is added, and hosted OpenWork Cloud does not register this provider.
