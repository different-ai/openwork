# Auth & Security settings

- **Retired rollout key:** `authSecuritySettings`
- **Deployments:** cloud and self-hosted; generally available (no flag)
- **Author:** @OmarMcAdam

## What changes

Den's Settings group shows one **Auth & Security** entry instead of separate
**SSO** and **SCIM** entries. The page has three tabs, without their own page
titles:

| Tab | URL | Was |
| --- | --- | --- |
| General (session settings), the default | `/dashboard/auth-security` or `?tab=general` | new ([session-security-settings](../session-security-settings/README.md)) |
| Single sign-on (SSO) | `/dashboard/auth-security?tab=sso` | `/dashboard/sso` |
| User provisioning (SCIM) | `/dashboard/auth-security?tab=scim` | `/dashboard/scim` |

Nothing about how SSO or SCIM work changes: same API (`/v1/sso*`, `/v1/scim*`),
same permissions (`sso.view`/`sso.manage`, `scim.view`/`scim.manage`), same
plan locks (SSO on Team, SCIM on Enterprise) and the same SSO test pop-up.

- **Navigation:** the entry shows when the person could see either SSO or SCIM
  before. The command palette lists **Settings › Auth & Security** and finds it
  by "sso", "saml", "oidc", "scim", "provisioning", "okta", "entra" and similar.
- **Old links:** `/dashboard/sso` and `/dashboard/scim` redirect to the
  matching tab and keep any other query parameters. The SSO test return page (`/sso/test/complete`) talks to the opener window
  and is unaffected.

## For whom

Organization owners and anyone granted the SSO or SCIM permissions. Members
without them never saw these entries and still don't.

## Try it locally

Start den-api (`pnpm dev:den:api`) and open **Settings › Auth & Security**. To see the plan locks, also set
`DEN_PLAN_GATING_ENABLED=true`; an organization on the Free plan sees the plan restrictions,
and one whose `organization.metadata.plan.tier` is
`enterprise` gets both tabs unlocked.

## What to watch

Nothing new on the server. In den-web, check that `/dashboard/sso` and
`/dashboard/scim` visits end on the Auth & Security tab (no redirect loop) and
that the SSO test pop-up still reports back to the tab.
