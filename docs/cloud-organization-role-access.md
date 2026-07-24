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

`owner` satisfies every organization gate. `super-admin` satisfies super-admin and admin gates. `admin` satisfies admin gates. `member` satisfies member gates only.

Organizations may have multiple `super-admin` and `admin` members. Each organization has exactly one protected `owner`; the owner role cannot be assigned through invitations or member role changes, and the owner member cannot be removed.

## Ownership transfer

Only the current `owner` can transfer ownership. The target must be an active `super-admin`. After transfer, the target becomes the sole `owner` and the previous owner becomes `super-admin`.

## Den Web sidebar

For cloud organization admins (`owner`, `super-admin`, and `admin`), the Den Web sidebar order is:

- Dashboard
- Your Connections, when enabled
- Extensions
  - Marketplace
  - Sources
  - Plugins
  - Connectors
- Models
  - OpenWork Models
  - LLM Providers
- Members
- Analytics
- Settings
  - General
  - Diagnostics
  - Brand appearance
  - Desktop Policies
  - Stripe
  - API Keys
  - SSO
  - SCIM

Plain members have member access only: Dashboard, plus Your Connections when that capability is enabled.

## Role matrix

| Access or operation | `owner` | `super-admin` | `admin` | `member` |
| --- | --- | --- | --- | --- |
| Member-level workspace access | Yes | Yes | Yes | Yes |
| Operational mutation outside Settings | Yes | Yes | Yes | No |
| Settings visibility and reads | Yes | Yes | Yes, read-only | No in Den Web |
| Settings writes | Yes | Yes | No | No |
| Member role changes | Yes, except owner | Yes, except owner | No | No |
| Invitations | Invite assignable non-owner roles | Invite assignable non-owner roles | Invite `member` only | No |
| Removals | Remove non-owner members | Remove non-owner members | Remove non-owner members | No |
| Ownership transfer | Yes, to active `super-admin` | No | No | No |

The owner is the only undeletable member role. Admins can invite members and remove non-owner members, but cannot promote or demote members, write Settings, or invite elevated roles.

## Custom roles

Custom roles can add delegated permissions where the Den API supports them, but they do not replace the built-in hierarchy. Built-in role names are protected, the owner role remains transfer-only, and the highest built-in role in a member's role string controls owner/super-admin/admin/member gates.
