# Enterprise Plan Gating: SSO + Desktop Policies

Status: implemented behind `DEN_PLAN_GATING_ENABLED` (default off)
Owner: growth/enterprise
Related: `docs/desktop-app-policies.md`, `ee/apps/den-api/src/sso.ts`, `ee/apps/den-api/src/routes/org/desktop-policies.ts`

## Goal

Move SSO/SAML and Desktop Policies into an Enterprise plan without breaking any
org that already uses them, and package the offering so it is attractive to
companies (managed deployment, skill development, MCP consulting).

## Packaging

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | Open-source desktop app, BYO keys; Cloud limited to 5 users |
| Team | $10 / user / month | Unlimited users, SSO/SAML, API access, marketplace/plugin management, distributed keys |
| Enterprise | Custom | Everything in Team, plus: SCIM, Desktop policies & version controls, enforced SSO (`requireSso`), analytics, audit log, managed deployment (self-hosted or hosted by us), custom skill development, MCP consulting, rollout support, custom commercial terms |

SSO/SAML is a Team feature: the `sso` entitlement is granted to the `team` and
`enterprise` tiers. Enforced SSO (`orgControls`) stays Enterprise.

Services (sold with Enterprise, delivered by us):

- **Managed deployment** — we run Den (or guide a self-hosted install), wire up
  the customer's gateway/LiteLLM, IdP, and version pinning.
- **Skill development** — we build org-specific skill plugins and marketplace packs for
  the customer's workflows.
- **MCP consulting** — we connect internal data sources and tools as MCP
  servers, with policy guardrails.

## What gets gated (and what never does)

Principle: **gate management (writes), never delivery (reads) or removal
(deletes).** An org that loses entitlement keeps working; it just can't add or
edit enterprise configuration.

Gated (return HTTP 402 without the entitlement):

- Team or Enterprise: `POST /v1/sso/saml`, `POST /v1/sso/oidc` — register/replace SSO connection
  (`ee/apps/den-api/src/routes/org/sso.ts`)
- Team or Enterprise: `POST /v1/sso/request-domain-verification`, `POST /v1/sso/verify-domain`
- Enterprise: `POST /v1/desktop-policies`, `PATCH /v1/desktop-policies/:id` — create/edit
  policies and assignments (`routes/org/desktop-policies.ts`)
- Enterprise: `PATCH /v1/org` **only when the patch touches** `requireSso` or
  `allowedDesktopVersions` (`routes/org/core.ts` → `orgs.ts:updateOrganizationSettings`)
- Enterprise (`scim`): `POST /v1/scim/token` and SCIM user creation
  (`POST /api/auth/scim/v2/Users`).
- Team or Enterprise (`sso`): automatic sign-up through SSO, and joining by
  signing in with an email on the organization's verified SSO domain
  (`identity-provisioning.ts`). Outside Enterprise these also respect the Free
  plan user limit, like invitations. Invited people can always sign in with SSO.
- `DEN_PLAN_GATING_ENABLED` is a den-api environment variable; den-web only
  reads the resulting `entitlements` from `GET /v1/org`.

Never gated:

- SSO **sign-in** for end users: `/sso/<orgSlug>`, `GET /v1/orgs/sso/resolve`,
  ACS/callback routes. Existing connections keep authenticating users forever.
- `GET /v1/me/desktop-config` — policies already defined keep being delivered
  to and enforced by the desktop app.
- All `GET` endpoints (admins can always see their config).
- All `DELETE` endpoints (`DELETE /v1/sso`, `DELETE /v1/desktop-policies/:id`)
  — downgrading/removing must always be possible.
- SCIM deprovisioning and updates for an already-provisioned connection.

This guarantees zero breakage: nothing that runs today stops running. The only
new friction is on *changing* enterprise config without a plan.

## Plan model

Follow the existing org-metadata pattern (`organization-limits.ts` already
stores `limits`, `requireSso`, `allowedDesktopVersions`, `inference` there).

```ts
// organization.metadata
{
  plan?: {
    tier: "free" | "team" | "enterprise"
    source: "default" | "stripe" | "manual" | "grandfathered"
    grandfatheredAt?: string // ISO date, set by backfill
  }
}
```

New module `ee/apps/den-api/src/entitlements.ts`:

```ts
type EntitlementKey = "sso" | "desktopPolicies" | "desktopVersionPinning" | "requireSso"

function getOrganizationEntitlements(org): Record<EntitlementKey, boolean>
// tier === "enterprise" (any source) => all true; tier === "team" => sso only; otherwise all false.

function requireEntitlement(org, key): void
// throws HTTPException 402 { error: "enterprise_plan_required", feature: key }
```

Reuse the existing 402 pattern from seat gating
(`routes/org/invitations.ts:136-148`, error `seat_subscription_required`).

### Kill switch

`DEN_PLAN_GATING_ENABLED` env var (parsed in `env.ts`). Default **off**:

- Hosted Den: we flip it on after the backfill runs.
- Self-hosted installs: stays off unless the operator opts in, so the
  open-source/ejectable story is unchanged. (The code already lives under
  `/ee` (FSL-1.1-MIT), which is the licensing boundary for these features.)

## Grandfathering (no-breakage migration, CI-applied)

Drizzle data migration
`ee/packages/den-db/drizzle/0023_grandfather_enterprise_plans.sql`, applied
automatically by the existing `den-db-migrate.yml` workflow when it lands on
`dev` — no manual step. It runs exactly once (tracked in
`__drizzle_migrations`) and is idempotent by construction. An org is
grandfathered to `plan: { tier: "enterprise", source: "grandfathered",
grandfatheredAt }` if any of:

1. A row exists in `sso_connection` for the org (any status), or
2. It has any non-default desktop policy, or a default policy whose values
   differ from the catalog defaults, or any `desktop_policy_member` rows, or
3. Org metadata has `requireSso === true` or non-empty `allowedDesktopVersions`.

Orgs already on the enterprise tier (e.g. `source: "manual"`) are left
untouched.

Grandfathered orgs get **full** enterprise entitlements indefinitely — they can
keep editing, not just keep running. They are flagged (`source:
"grandfathered"`) so sales can see them in the admin backoffice and reach out
at renewal time; we never auto-expire them.

Rollout order (each step independently safe):

1. Merge: entitlement code ships dark (`DEN_PLAN_GATING_ENABLED` unset) and CI
   applies the grandfathering migration in the same deploy.
2. Update landing/pricing pages (separate PR).
3. Enable the flag on hosted Den. Do this soon after the merge: orgs that
   first adopt SSO/policies *between* the migration and the flag flip are not
   grandfathered (acceptable — gating only blocks edits, never breaks what
   they configured; ship a follow-up data migration if the gap grows long).
4. Manual plan assignment via the instance admin surface
   (`routes/admin/index.ts`) still works; Stripe-billed Enterprise is described
   under "Enterprise plan billing" below.

## UX when gated

- **den-web dashboard** (`dashboard/sso/`, `dashboard/(admin)/desktop-policies/`,
  org settings requireSso/version toggles): screens stay visible but show an
  "Enterprise" badge and a "Talk to us" CTA (→ `openworklabs.com/enterprise#book`)
  instead of the create/edit actions, driven by an `entitlements` object added
  to the existing org payload in `org-dashboard-provider.tsx`. Handle the 402
  defensively as well.
- **Desktop app**: no changes. `DesktopConfigProvider` and restriction notices
  (`restriction-notice-provider.tsx`) keep working for orgs whose policies were
  set while entitled or grandfathered.

## Explaining desktop policies (positioning)

Desktop policies are the "managed desktop controls" pillar of Enterprise.
End-user messaging already exists (`userNotice` per policy in
`packages/types/src/den/desktop-policies.ts` + restriction notice modal); the
marketing story is:

> Admins decide which providers, models, extensions, and app versions employees
> can use. The desktop app enforces it automatically — no MDM scripting.

This is reflected on `/pricing` and `/enterprise` as "Desktop policies &
version controls".

## One place for an organization's plan and users

A platform admin sets an organization's plan in `/admin` › organization ›
**Billing** (`PATCH /v1/admin/organizations/:id/plan`, or the admin MCP tool
`den_update_org_plan`; both call `setOrganizationPlanByAdmin`): Free, Team or
Enterprise, how many users it allows, and for Team and Enterprise an optional
end date. Stored in `organization.metadata.plan` (`tier`, `source`, `seats`,
`endsAt`, `grantedAt`, `grandfatheredAt`); `limits.members` mirrors the number
for one release. On Free the number is stored as `seatsFreeAdditional` above 5.

One pure rule (`ee/apps/den-api/src/organization-plan.ts`) decides how many
users an organization may have, counting pending invitations, for every way
people join: email invitations, SSO sign-up and verified-domain joins, and
SCIM. No feature flag takes part.

- An active paid Stripe plan (Team seat subscription active or trialing; a
  sales-led Enterprise subscription active, trialing or past due): no limit.
- Otherwise a Team or Enterprise plan a platform admin set, or grandfathered:
  its seats, never fewer than 5.
- Otherwise Free: 5 plus any extra free users.

Limits apply only where seat billing gates members (hosted multi-organization
deployments with Stripe seat billing configured). A full Free workspace gets
the 402 Team upgrade; a full plan OpenWork set gets `409 org_limit_reached`
("Your Enterprise plan includes N users… Ask your OpenWork contact to add
seats."), never the Team upgrade. The end date is display only: `/admin` and
the customer Billing page show "Ended <date>", and nothing changes.

## Enterprise plan billing (sales-led)

A plain `/admin` control (no feature flag). Enterprise is sold by us and billed
through Stripe, not bought at checkout.

- **Stripe setup:** one Enterprise product (`STRIPE_ENTERPRISE_PRODUCT_ID` on
  den-api). Each customer gets their own recurring per-user price on that
  product, so subscriptions are recognised by product, not price.
- **Starting it:** a platform admin opens the organization's Billing tab in
  `/admin`, expands "Bill an Enterprise contract through Stripe" and enters the
  contract price, the committed minimum users, the billing email and the
  invoice terms (`POST /v1/admin/organizations/:id/enterprise-subscription`).
  Den creates a `send_invoice` subscription with `subscription_type:
  enterprise` and `minimum_users` in its metadata. A Team plan (seat)
  subscription is canceled with a prorated credit, and an admin-set or
  grandfathered plan is handed over to Stripe
  (`plan: { tier: "enterprise", source: "stripe" }`).
- **Quantity:** every user (the same count as Team, Models and Web), never
  below the committed minimum, at least 1. It follows member and invitation
  changes like the other subscriptions. The minimum is changed with
  `PATCH .../enterprise-subscription` (stored in Stripe metadata and mirrored to
  `org_subscriptions.minimum_quantity`).
- **Plan:** while the Enterprise subscription is active, trialing or past due
  the organization is Enterprise from Stripe; it outranks Team. When it ends the
  organization falls back to Team if it still pays for Team, otherwise Free.
  Admin-set and grandfathered plans are never changed by Stripe.
- **User limit:** an active Enterprise subscription has no user limit (Stripe
  bills every user); see the rule above.
- **Billing page:** organizations with an Enterprise subscription see an
  Enterprise plan card (users billed, minimum, next invoice, invoices in the
  Stripe portal) instead of the Team plan card. OpenWork Models and OpenWork
  Web stay separate subscriptions.

## Open questions

- Enterprise self-serve checkout: not built; sales-led only for now.
- Stripe billing sets `plan: { tier: "team", source: "stripe" }` while an
  organization's Team plan (seat) subscription is active, trialing or past due,
  and returns it to Free when it ends. Migration
  `0155_enterprise_plan_subscriptions` applies the same rule once to every
  environment.
- Moving the existing admin-set and grandfathered Enterprise organizations onto
  Stripe Enterprise subscriptions is a sales decision, made one organization at
  a time from `/admin`.
