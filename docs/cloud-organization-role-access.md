# Cloud organization role access

This guide documents the approved cloud organization hierarchy as it exists today.

## Scope

Organization roles authorize access inside one cloud workspace. They are separate from platform Den admin access: platform Den admins are allowlisted operators for Den admin routes and the den-admin MCP surface, and organization `owner` or `super-admin` roles do not grant that platform access.

Den Web controls enforce policy in the client by hiding or disabling actions, and Den API endpoints enforce policy by rejecting unauthorized requests. UI disabling is not security enforcement; route guards and handler checks are the security boundary. Settings reads and writes are checked separately, and OpenWork Models is an operational Models surface outside Settings.

## Built-in hierarchy

The built-in organization roles are ordered:

1. `owner`
2. `super-admin`
3. `admin`
4. `member`

`owner` satisfies every organization gate and always holds every catalog permission. `super-admin` satisfies super-admin and admin gates. It holds every catalog permission, like the owner; with the `superAdminPermissionSet` feature on it instead holds the organization's Super admin permissions (plus Member and Admin): a default permission set (`permission_set.default_key = 'super-admin'`) seeded with every catalog permission, kept current by reconciliation, and editable only by the owner or a super-admin (see `docs/features/super-admin-permission-set/README.md`). Only deleting the organization and transferring ownership stay owner-only role checks. `admin` satisfies admin gates and holds the organization's Admin permissions. `member` satisfies member gates only.

Only the owner or a super-admin can make someone a super-admin (by invitation or role change), change a super-admin's role, or remove a super-admin. Nobody but the owner can change their own role. Code: `ee/apps/den-api/src/organization-role-hierarchy.ts` and `ee/apps/den-api/src/permissions/role-assignment.ts`.

Organizations may have multiple `super-admin` and `admin` members. Each organization has exactly one protected `owner`; the owner role cannot be assigned through invitations or member role changes, and the owner member cannot be removed.

## Ownership transfer

Only the current `owner` can transfer ownership; a `super-admin` cannot. The target must be an active `admin` or `super-admin`. After transfer, the target becomes the sole `owner` and the previous owner becomes `admin`.

## Den Web sidebar

For cloud organization admins (`owner`, `super-admin`, and `admin`), the Den Web sidebar order is:

- Work
  - Dashboard
  - My Library
  - My Automations, when enabled
  - OpenWork Web, when enabled
- Manage
  - Plugin Directory, with Plugins, Agents, Commands, Hooks, MCPs, and Sources tabs
  - Connectors
  - Dashboards, when enabled
  - Models
    - OpenWork Models, on hosted deployments only
    - Bring your Own Keys
  - Advanced, with Collections, Desktop policies, and Brand appearance tabs
- Observability
  - Workflow Runs, when enabled
  - Analytics
- Team
  - Members
  - Settings
    - General
    - Diagnostics
    - Billing
    - API Keys
    - SSO
    - SCIM
    - Tool Tester, when connectors are enabled

Plain members have member access only: Dashboard, My Library, and My Automations / OpenWork Web when enabled.

## Role matrix

| Access or operation | `owner` | `super-admin` | `admin` | `member` |
| --- | --- | --- | --- | --- |
| Member-level workspace access | Yes | Yes | Yes | Yes |
| Operational mutation outside Settings | Yes | Yes | Yes | No |
| Settings visibility and reads | Yes | Yes | Yes, read-only | No in Den Web |
| Settings writes | Yes | Yes | No | No |
| Member role changes | Yes, except owner | Yes, except owner and their own | With `members.update`, except owner and super-admins | No |
| Invitations | Invite assignable non-owner roles | Invite assignable non-owner roles | With `members.update`, `member` or `admin` | No |
| Removals | Remove non-owner members | Remove non-owner members | Remove non-owner members except super-admins | No |
| Ownership transfer | Yes, to an active `admin` or `super-admin` | No | No | No |
| Delete organization | Yes | No | No | No |

The owner is the only undeletable member role. What admins can do beyond the table follows the organization's Admin permissions. With `superAdminPermissionSet` on, the `super-admin` column shows the shipped Super admin permissions (every permission); if the owner or a super-admin trims that set, super-admins lose the trimmed permissions while keeping their role-hierarchy rights (managing super-admins and admins).

## Custom roles

Custom roles can add delegated permissions where the Den API supports them, but they do not replace the built-in hierarchy. Built-in role names are protected, the owner role remains transfer-only, and the highest built-in role in a member's role string controls owner/super-admin/admin/member gates.
