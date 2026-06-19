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
| Solo | $0 | Open-source desktop app, BYO keys |
| Team Starter | $50/mo | 5 seats, API access, Skill Hub Manager, distributed keys |
| Enterprise | Custom | Everything in Team, plus: SSO/SAML + SCIM, Desktop policies & version controls, enforced SSO (`requireSso`), managed deployment (self-hosted or hosted by us), custom skill development, MCP consulting, rollout support, custom commercial terms |

Services (sold with Enterprise, delivered by us):

- **Managed deployment** — we run Den (or guide a self-hosted install), wire up
  the customer's gateway/LiteLLM, IdP, and version pinning.
- **Skill development** — we build org-specific skills and Skill Hub packs for
  the customer's workflows.
- **MCP consulting** — we connect internal data sources and tools as MCP
  servers, with policy guardrails.

## What gets gated (and what never does)

Principle: **gate management (writes), never delivery (reads) or removal
(deletes).** An org that loses entitlement keeps working; it just can't add or
edit enterprise configuration.

Gated (require `enterprise` entitlement, return HTTP 402):

- `POST /v1/sso/saml`, `POST /v1/sso/oidc` — register/replace SSO connection
  (`ee/apps/den-api/src/routes/org/sso.ts`)
- `POST /v1/sso/request-domain-verification`, `POST /v1/sso/verify-domain`
- `POST /v1/desktop-policies`, `PATCH /v1/desktop-policies/:id` — create/edit
  policies and assignments (`routes/org/desktop-policies.ts`)
- `PATCH /v1/org` **only when the patch touches** `requireSso` or
  `allowedDesktopVersions` (`routes/org/core.ts` → `orgs.ts:updateOrganizationSettings`)

Never gated:

- SSO **sign-in** for end users: `/sso/<orgSlug>`, `GET /v1/orgs/sso/resolve`,
  ACS/callback routes. Existing connections keep authenticating users forever.
- `GET /v1/me/desktop-config` — policies already defined keep being delivered
  to and enforced by the desktop app.
- All `GET` endpoints (admins can always see their config).
- All `DELETE` endpoints (`DELETE /v1/sso`, `DELETE /v1/desktop-policies/:id`)
  — downgrading/removing must always be possible.
- SCIM token usage for an already-provisioned connection.

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
// tier === "enterprise" (any source) => all true; otherwise all false.

function requireEntitlement(org, key): void
// throws HTTPException 402 { error: "enterprise_plan_required", feature: key }
```

Reuse the existing 402 pattern from seat gating
(`routes/org/invitations.ts:136-148`, error `seat_subscription_required`).

### Kill switch

`DEN_PLAN_GATING_ENABLED` env var (mirrors `POLAR_FEATURE_GATE_ENABLED` in
`env.ts` / `billing/polar.ts`). Default **off**:

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
4. Manual plan assignment for new enterprise customers via existing instance
   admin surface (`routes/admin/index.ts`) until Stripe enterprise products
   exist; later, optionally a third `OrgSubscriptionTable.type = "enterprise"`.

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

## Open questions

- Do we gate SCIM token *generation* too? (Suggested: yes, same entitlement as
  SSO, since it's part of identity provisioning.)
- Enterprise self-serve checkout vs. sales-led only (suggested: sales-led
  first; the CTA is already a Cal.com booking).
- Whether Team Starter should eventually include a single OIDC connection as a
  mid-tier hook (defer).
