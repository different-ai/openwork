# SSO sign-in requirement on the SSO page

- Feature key: `ssoSettingsOnSsoPage`
- Deployments: cloud and self-hosted (off by default)
- Author: OmarMcAdam

## What changes

The **Authentication › Single sign-on requirement** card (Require SSO and,
with `ssoPerOrganization`, Restrict this domain to our SSO) moves from
**Org settings** (`/dashboard/org-settings`) to the top of the **SSO** page
(`/dashboard/sso`), above the SSO connection form.

- On: the card shows on the SSO page with its own **Save** button. Org settings
  no longer shows it and its **Save settings** no longer sends `requireSso` or
  `restrictDomainToSso`.
- Off: the card stays in Org settings, as before.

Both places save through the same `PATCH /v1/org` call with the same
`organization.update` permission. No data moves, so turning the flag off at any
time only changes where the card is shown.

## How to try it

1. Turn `ssoSettingsOnSsoPage` on for an organization in `/admin`.
2. Open `/dashboard/sso`: the card is at the top. Toggle Require SSO and save.
3. Open `/dashboard/org-settings`: the Authentication card is gone.
