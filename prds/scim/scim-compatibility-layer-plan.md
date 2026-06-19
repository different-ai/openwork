# SCIM Compatibility Layer Plan

## Context

The first SCIM test run showed that Better Auth's default SCIM plugin is useful plumbing, but it is not fully compatible with the SCIM tester or Den's identity model.

Observed failures:

- `/ResourceTypes` advertises only `User`; tester expects `Group` too.
- `/Schemas` advertises only the User schema; tester expects a Group schema too.
- arbitrary remote IDs such as `9876543210123456` can hit Den TypeID normalization and become `500` instead of SCIM `404`.
- `startIndex` and `count` are ignored in list responses.
- SCIM `userName` is not preserved; responses derive `userName` from local email.
- PATCH returns `204`, while the tester expects `200` with an updated user resource.

## Goal

Add a Den-owned SCIM compatibility layer that keeps Better Auth's useful connector/token pieces while giving OpenWork control over SCIM resource identity, response shape, pagination, and group semantics.

## Identity Model

Do not store SCIM remote identity directly on the global Better Auth `user` row by default.

Use an org/provider-scoped identity table instead, because the same local user may be known differently by different organizations or identity providers.

Proposed table: `scim_identity`

- `id`: Den TypeID, e.g. `sci_...`
- `organizationId`: owning OpenWork org
- `providerId`: SCIM provider connection id
- `userId`: local Better Auth user id
- `remoteId`: remote immutable id when supplied by the IdP
- `externalId`: SCIM `externalId`
- `userName`: SCIM `userName`
- `displayName`: SCIM `displayName`
- `nameJson`: raw SCIM `name` object
- `emailsJson`: raw SCIM `emails` array
- `active`: SCIM active flag
- `createdAt`
- `updatedAt`

Indexes and constraints:

- unique `(organizationId, providerId, userId)`
- unique `(organizationId, providerId, externalId)` when externalId exists
- unique `(organizationId, providerId, userName)` when userName exists
- optional unique `(organizationId, providerId, remoteId)` when remoteId exists

This lets Den return SCIM protocol fields without forcing those values into global app identity.

## User Resource Behavior

### Create User

On `POST /scim/v2/Users`:

1. Authenticate through the org-scoped SCIM provider/token.
2. Extract SCIM identity fields:
   - `externalId`
   - `userName`
   - `name`
   - `displayName`
   - `emails`
   - `active`
3. Resolve or create the local user using explicit Den policy:
   - default: use primary email for local user email
   - if an existing local user has that email, attach org membership only if policy allows
4. Create or update `scim_identity` for the provider/org/user mapping.
5. Return a SCIM User resource built from `scim_identity` plus local user metadata.

Response rule:

- `userName` should be the SCIM `userName`, not necessarily local email.
- local email can still appear under `emails`.
- `id` can remain the Den local user id unless we later choose opaque SCIM resource ids.

### Get User

On `GET /scim/v2/Users/:userId`:

1. If `:userId` is not a valid Den user TypeID, return SCIM `404` rather than letting Drizzle/TypeID throw.
2. Lookup by local user id within the authenticated provider/org.
3. Return the SCIM resource from `scim_identity`.

Future option:

- If IdPs require their own resource IDs, add `scim_identity.remoteResourceId` and allow lookup by that value too.

### List Users

On `GET /scim/v2/Users`:

1. List identities scoped to authenticated provider/org.
2. Support `startIndex` as SCIM 1-based pagination.
3. Support `count` as page size.
4. Return `startIndex` equal to the requested normalized value.
5. Return `itemsPerPage` equal to the number of resources in the current page.
6. Keep `totalResults` equal to total matching identities before pagination.

### Update User

On `PUT /scim/v2/Users/:userId`:

1. Validate and resolve the user in provider/org scope.
2. Update `scim_identity` fields from the SCIM payload.
3. Update local user fields only according to explicit Den policy.
4. Return `200` with the updated SCIM resource.

### Patch User

On `PATCH /scim/v2/Users/:userId`:

1. Apply supported SCIM patch operations to `scim_identity`.
2. Update local user fields only according to explicit Den policy.
3. Return `200` with the updated SCIM resource for compatibility with the current tester.

### Delete User

On `DELETE /scim/v2/Users/:userId`:

1. Remove or deactivate org membership for the SCIM-managed org.
2. Remove or deactivate the `scim_identity` mapping.
3. Do not delete the global local user by default.
4. Return `204` when the org-scoped access was removed.

## Group Resource Model

SCIM `Group` is closest to OpenWork org teams, but it is not exactly the same thing.

A SCIM Group is an IdP-owned membership container. It may represent teams, departments, roles, app assignments, or access policy groups. OpenWork org teams are local collaboration/access structures inside an organization.

Recommended stance:

- Treat SCIM Groups as remote-owned groups.
- Map them to org teams only if the org enables that behavior.
- Keep enough remote group metadata to avoid losing IdP identity even if no local team is created.

Proposed table: `scim_group`

- `id`: Den TypeID, e.g. `scg_...`
- `organizationId`
- `providerId`
- `teamId`: optional local org team id
- `remoteId`: remote immutable id when supplied
- `externalId`: SCIM `externalId`
- `displayName`: SCIM Group `displayName`
- `membersJson`: optional raw member references if we defer normalized membership
- `createdAt`
- `updatedAt`

Proposed table: `scim_group_member`

- `id`
- `organizationId`
- `providerId`
- `groupId`
- `identityId`
- `userId`
- `teamMemberId`: optional local team member link
- `createdAt`
- `updatedAt`

## Group Support Phases

### Phase 1: metadata compatibility

Add Group schema and resource type to:

- `/scim/v2/Schemas`
- `/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group`
- `/scim/v2/ResourceTypes`
- `/scim/v2/ResourceTypes/Group`

This addresses metadata discovery failures without committing to full group lifecycle yet.

### Phase 2: minimal Group CRUD

Implement:

- `GET /scim/v2/Groups`
- `GET /scim/v2/Groups/:groupId`
- `POST /scim/v2/Groups`
- `PUT /scim/v2/Groups/:groupId`
- `PATCH /scim/v2/Groups/:groupId`
- `DELETE /scim/v2/Groups/:groupId`

Initial behavior can store remote group records without creating local teams.

### Phase 3: optional team mapping

If product wants SCIM groups to manage OpenWork teams:

1. Add org setting: `scimGroupMappingMode`.
2. Modes:
   - `metadata_only`: store groups, do not create teams.
   - `create_teams`: create/update org teams from SCIM groups.
   - `manual_mapping`: admin maps specific SCIM groups to specific teams.
3. Apply group membership changes to local team membership only when enabled.

## Compatibility Route Layer

Add Den-owned route handlers before or instead of Better Auth's raw SCIM lifecycle handlers for protocol resources.

Keep Better Auth for:

- SCIM provider table bootstrapping if still useful
- token generation
- token validation middleware or equivalent validation logic
- admin management where it matches Den org boundaries

Own in Den:

- User resource serialization
- Group resource serialization
- user/group CRUD semantics
- pagination
- invalid ID handling
- userName/externalId preservation
- local user mutation policy

## Test Targets

Add tests that cover the reported failures directly:

1. `/ResourceTypes` includes both `User` and `Group`.
2. `/Schemas` includes both User and Group schemas.
3. invalid `GET /Users/:id` returns SCIM `404`, not `500`.
4. `GET /Users?startIndex=20&count=5` echoes `startIndex: 20` and correct `itemsPerPage`.
5. `POST /Users` returns the submitted SCIM `userName`.
6. `PUT /Users/:id` returns the updated SCIM `userName`.
7. `PATCH /Users/:id` returns `200` and updated resource.
8. `DELETE /Users/:id` removes org-scoped SCIM access without deleting the global user.

## Open Questions

1. Should local user email always come from SCIM primary email, or can SCIM `userName` be an email substitute?
2. Should `id` in SCIM responses be local `usr_...`, or should we expose an opaque SCIM resource id from `scim_identity`?
3. Should existing local users be auto-linked by email, or should collisions require admin approval?
4. Should SCIM Group-to-team mapping be enabled by default, opt-in, or deferred?

## Proposed Decision

Proceed with a Den-owned compatibility layer and `scim_identity` storage before declaring SCIM production-ready.

Ship order:

1. Add `scim_identity` and preserve remote user fields.
2. Override User list/get/create/update/patch/delete behavior enough to pass the tester.
3. Add Group schema/resource type metadata.
4. Add minimal Group storage.
5. Add optional org-team mapping after product confirms desired semantics.
