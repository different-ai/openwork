# SSO sign-in requirement on the SSO page

- Retired rollout key: `ssoSettingsOnSsoPage`
- Deployments: cloud and self-hosted; generally available (no flag)
- Author: OmarMcAdam

## What changes

The **Authentication › Single sign-on requirement** card (Require SSO and,
with `ssoPerOrganization`, Restrict this domain to our SSO) moves from
**Org settings** (`/dashboard/org-settings`) to the top of the **Single
sign-on** tab of Auth & Security (`/dashboard/auth-security?tab=sso`), above
the SSO connections.

The card has its own **Save** button and saves through `PATCH /v1/org` with the
`organization.update` permission, as before. Org settings no longer shows it,
and its **Save settings** no longer sends `requireSso` or `restrictDomainToSso`.

## How to try it

1. Open `/dashboard/auth-security?tab=sso`: the card is at the top. Toggle
   Require SSO and save.
2. Open `/dashboard/org-settings`: the Authentication card is gone.
