# SCIM for Den API

## Goal

Add self-serve SCIM to `ee/apps/den-api` so an organization in OpenWork Cloud can:

- create and manage its own SCIM connector
- rotate its own SCIM bearer token
- provision users only into that organization
- keep SCIM configuration and lifecycle clearly scoped to an organization

This document also evaluates whether Better Auth's SCIM plugin matches those boundaries.

## Short Answer

Better Auth's SCIM plugin is partially suitable.

- It does support organization-scoped SCIM connectors.
- It does scope SCIM management access by organization membership and role.
- It does provision a SCIM-created user into the organization attached to the SCIM token.

But it is not fully organization-isolated at the user lifecycle layer.

- The underlying `user` record is global to the whole app.
- If a SCIM-created email already exists, the plugin reuses that global user.
- `PUT` and `PATCH` update the global user row.
- `DELETE` deletes the global user, not just the organization membership.

So the plugin is good for org-scoped connector management, but not safe enough as-is if we require strict per-org lifecycle separation.

## Recommendation

Use the Better Auth SCIM plugin for connector management and token auth, but do not trust its user lifecycle behavior blindly.

Use the plugin for:

- org-scoped SCIM connector records
- token generation and rotation
- SCIM request authentication
- org-scoped list/get filtering

Do not ship the raw plugin lifecycle behavior unless we explicitly accept these semantics:

- SCIM can attach an existing global app user into an org by email
- SCIM updates can change global app user profile fields
- SCIM delete can delete the whole app user

For OpenWork Cloud, the safer stance is:

- connector is per org
- membership is per org
- deletion should remove or disable org membership and connector account association, not blindly delete the whole user
- existing-user matching by email should be an explicit policy decision, not an accidental default

## Implementation Options

### Option A: adopt plugin as-is

Pros:

- fastest path
- lowest implementation effort

Cons:

- global user side effects
- weak lifecycle separation
- risky delete semantics

Recommendation:

- not preferred unless we explicitly accept app-global identity coupling

### Option B: use plugin for auth and connector storage, override destructive lifecycle behavior

Pros:

- keeps the good parts of org-scoped SCIM
- reduces risk from global user mutation/deletion
- closer to OpenWork's org model

Cons:

- more integration work
- may require wrapping or forking parts of upstream behavior

Recommendation:

- preferred

### Option C: custom SCIM implementation

Pros:

- full control over org boundaries

Cons:

- highest maintenance burden
- duplicates standards work already done upstream

Recommendation:

- only if upstream hooks or extension points are insufficient

## Recommended Plan

### Phase 1: wire core SCIM support

1. Add `@better-auth/scim` to `ee/apps/den-api`.
2. Enable the plugin in `ee/apps/den-api/src/auth.ts`.
3. Update `ee/apps/den-api/src/routes/auth/index.ts` to forward `PUT`, `PATCH`, and `DELETE`.
4. Run the Better Auth migration so `scimProvider` exists in Den's schema.
5. Configure org-scoped `requiredRole` explicitly rather than relying on defaults.

### Phase 2: build Den self-serve admin UX

1. Add an org dashboard page in `den-web` for SCIM.
2. Show:
   - SCIM base URL
   - connection status
   - generated token one time
   - rotate token action
   - delete connection action
3. Restrict visibility to owner/admin, aligned with Den org permissions.
4. Generate internal provider ids server-side.

### Phase 3: resolve lifecycle separation

1. Decide policy for email collision with an existing global app user.
2. Decide policy for SCIM update of name/email on an existing shared user.
3. Replace or wrap delete behavior so org offboarding does not unintentionally delete the global user.
4. Decide whether SCIM should deactivate membership, remove membership, or soft-delete an org-specific auth link.

### Phase 4: optional enterprise hardening

1. Add audit logging for token generation, rotation, and connector deletion.
2. Add group-to-role or group-to-team mapping if required.
3. Add connector health indicators and recent sync error visibility.
4. Add policy hooks for approved SCIM operators.

## Decisions Needed Before Build

1. Are OpenWork identities allowed to be globally shared across orgs when SCIM emails match?
2. Should SCIM delete remove the global user, remove only the org membership, or just deactivate access?
3. Should SCIM-provisioned users always land as `member`, or should org admins choose a default role?
4. Do we need SCIM only, or full enterprise identity including SSO in the same admin surface?

## Proposed Decision

Proceed with Option B.

That means:

- use Better Auth SCIM for org-scoped connector plumbing
- keep connectors directly attached to organizations
- build self-serve org admin UX in Den
- add a Den-owned lifecycle policy layer before trusting update/delete behavior in production
