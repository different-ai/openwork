# New Plugin Arch RBAC

This document captures the first-pass RBAC design for the new plugin architecture.

It is intentionally written as a discussion doc, not a final policy spec.

## Goal

We want one consistent RBAC model across:

- config objects
- plugins
- connector instances

And we also need org-level permissions for who can:

- create and edit those resources
- configure connector ingestion
- manage delivery/access
- view and debug sync state

## Main design principle

There are really two different permission layers:

1. org capability permissions
   - what a member is allowed to do in the org in general
2. resource access permissions
   - what a member/team can do with a specific config object, plugin, or connector instance

That split is important.

Example:

- a user may have org permission to create plugins;
- but they may still not have access to edit a specific existing plugin.

Locked decision:

- org admins should have implicit full access to every resource in the org.

## Resources that need RBAC

### Org-scoped capability layer

These are not tied to one individual row.

Examples:

- can create config objects
- can create plugins
- can create connector accounts
- can create connector instances
- can manage org-wide access policies
- can view connector sync diagnostics

### Resource-scoped access layer

These apply to individual resources.

Resources:

- one `config_object`
- one `plugin`
- one `connector_instance`

Current recommendation:

- do not make `connector_account` a day-one first-class resource with separate fine-grained RBAC unless we need it;
- use org-level capability permissions for connector account setup, and resource-level permissions for connector instances.

## Actors

The natural principals appear to be:

- org member
- team

Current recommendation:

- grants should be assignable to either a member or a team;
- resources should also be shareable with the org as a whole without creating per-user grants;
- effective access is the union of direct grants plus team grants;
- ownership/creator metadata should not automatically become the only authorization model.

Locked decision:

- config objects and plugins should be private by default.
- sharing should happen through explicit RBAC grants only.

## What we likely need to protect

### Config objects

Actions:

- view metadata
- view current content
- view history
- create new version
- edit current metadata
- archive/delete/restore
- manage object access
- attach/detach from plugins

### Plugins

Actions:

- view metadata
- view resolved members
- edit metadata
- add/remove config objects
- manage plugin access
- view delivery preview/resolved manifest
- create release snapshot if releases exist

### Connector instances

Actions:

- view connector config
- edit connector config
- edit targets and mappings
- manually trigger sync
- view sync events/logs
- manage connector access
- disable/archive connector

## Recommended permission model shape

### Resource roles

For v1, role-based resource access is probably better than dozens of tiny per-action grants.

Recommended shared roles:

- `viewer`
- `editor`
- `manager`

Suggested semantics:

#### `viewer`

- can view resource metadata and current state
- can view resolved contents where applicable
- cannot mutate

#### `editor`

- can modify the resource's working content/config
- cannot manage sharing/access unless explicitly promoted

#### `manager`

- can edit the resource
- can change access grants
- can archive/restore
- can perform high-impact control actions

Current recommendation:

- start with shared roles across resource types, then add per-resource-type nuances in enforcement logic if needed.

## Org capability permissions

These likely belong on org membership roles or org-level grants.

Candidate capabilities:

- `config_object.create`
- `plugin.create`
- `connector_account.create`
- `connector_instance.create`
- `connector_sync.view_all`
- `connector_sync.retry`
- `rbac.manage_org`

Current implementation note:

- until separate org-capability persistence exists, the endpoint layer maps these capabilities to org owner/admin membership only.

Why this matters:

- resource grants alone do not answer "who is allowed to create a new thing?"
- we need an org capability gate before resource-level RBAC even applies.

## Resource access tables

This doc aligns with the table direction in `prds/new-plugin-arch/datastructure.md`.

Current recommendation:

- separate access tables with the same shape:
  - `config_object_access_grant`
  - `plugin_access_grant`
  - `connector_instance_access_grant`

Suggested shared columns:

- `id`
- resource id
- `org_membership_id` nullable
- `team_id` nullable
- `org_wide` boolean default false
- `role`
- `created_by_org_membership_id`
- `created_at`
- `removed_at` nullable

Additional guardrails:

- require exactly one grant target:
  - `org_membership_id`
  - `team_id`
  - or `org_wide = true`
- use soft revocation via `removed_at`
- compute effective role from the strongest active grant

Recommended interpretation:

- `org_wide = true` means "shared with the org";
- this creates org-wide visibility/access without creating rows for every member or team;
- config objects and plugins remain private until such a grant is added.
- member/team sharing still uses normal explicit grant rows.

Locked decision:

- use `org_wide = true` for v1.

## Recommended authorization rules by resource

### Config objects

#### View

Needs one of:

- direct object grant
- team object grant
- object has an active org-wide grant
- access to a plugin that currently includes the object
- org admin implicit access

#### Edit content / create version

Needs one of:

- `editor` or `manager` on the object

#### Manage object access

Needs:

- `manager` on the object

#### Attach object to plugin

Likely needs both:

- edit rights on the object
- edit rights on the target plugin

This is one of the first policy questions we should lock down.

### Plugins

#### View

Needs one of:

- direct plugin grant
- team plugin grant
- plugin has an active org-wide grant
- org admin implicit access

#### Edit plugin metadata / membership

Needs:

- `editor` or `manager` on the plugin

#### Manage plugin access

Needs:

- `manager` on the plugin

### Connector instances

#### View connector setup

Needs:

- direct or team connector-instance grant
- or org admin implicit access

#### Edit mappings / targets / config

Needs:

- `editor` or `manager` on the connector instance

#### Trigger sync / retry sync

Likely needs:

- `editor` or `manager` on the connector instance
- and maybe an org capability for retrying failed syncs if we want tighter control

#### Manage connector access

Needs:

- `manager` on the connector instance

## Delivery and access

Current direction from the other docs:

- plugin delivery is mostly controlled through plugin access grants.

That means:

- if team B has access to plugin A, that is effectively the publish step;
- the delivery system should resolve access from plugin grants, not from low-level config-object grants alone.

Current recommendation:

- plugin delivery should primarily check plugin access;
- config-object access should govern direct admin/editing access, not plugin delivery;
- a user should have access to a config object if any of the following are true:
  - they are directly granted access to the object
  - they are on a team granted access to the object
  - the object has an org-wide grant
  - the object is included in a plugin they can access
  - they are an org admin

This keeps the mental model simpler:

- plugins are the deliverable
- plugin access determines who gets the deliverable

## Connector-managed objects and RBAC

We already decided:

- connector-managed objects can still be edited locally;
- connector sync remains authoritative and may overwrite those edits later.

RBAC implication:

- connector origin should not automatically make an object read-only from an authorization perspective;
- authorization should still be based on the object's grants and org capabilities.

Locked decision:

- when a connector auto-creates an object, the creator should be the user who configured the connector behavior that caused the creation;
- after creation, the object follows normal permissions like any other object.

But we may want UX warnings when:

- a user has permission to edit;
- but their change is likely to be overwritten by the connector.

## Cross-resource mutation questions

These are the trickiest RBAC cases.

### Add object to plugin

Question:

- should a user need edit permission on both the object and the plugin?

Current recommendation:

- no.

Reason:

- plugin composition is controlled by the plugin;
- users only need edit rights on the plugin to add or remove objects from it.

### Bind connector mapping to plugin

Question:

- should a user need edit permission on both the connector instance and the plugin?

Current recommendation:

- yes.

### Auto-created objects from a connector mapping

Question:

- when a connector mapping auto-creates new objects and auto-adds them to a plugin, whose permission is that acting under?

Current recommendation:

- treat it as an automated action attributed to the human creator of the connector/mapping configuration that caused it.

This should be auditable as:

- `created_via = connector`
- `created_by_org_membership_id = <connector or mapping creator>`

## Inheritance and default access

This is still a major open area.

Questions:

- when a new config object is manually created, who gets initial access?
- when a new plugin is created, who gets initial access?
- should creator always get `manager`?

Current recommendation:

- creator gets initial `manager` grant;
- connector-created objects also default to the creator of the relevant connector/mapping action;
- org owners/admins have implicit override access across all resources;
- teams should only gain access through explicit grants, not automatic inheritance.

Locked decision:

- config objects and plugins are private by default;
- users can share with individual members, teams, or the org as a whole;
- whole-org sharing should not create per-user or per-team rows.

## Suggested v1 defaults

If we need a practical starting point now:

- org owner/admin
  - implicit full access to all plugin-arch resources in the org
- creator of a resource
  - explicit or implicit `manager` on that resource
- connector-created resource
  - creator is the user whose authorized connector/mapping configuration caused creation
- team/member grants
  - explicit only
- org-wide share
  - explicit only, via one grant that applies to the org as a whole
- delivery
  - controlled by plugin access grants
- object/plugin/connector roles
  - `viewer`, `editor`, `manager`

## API implications

The API surface in `prds/new-plugin-arch/admin-api.md` should assume:

- object access endpoints manage `config_object_access_grant`
- plugin access endpoints manage `plugin_access_grant`
- connector instance access endpoints manage `connector_instance_access_grant`

The API should also distinguish between:

- `403 forbidden because you lack org capability`
- `403 forbidden because you lack resource access`

That distinction will help a lot with admin UX.

## Locked decisions so far

1. Org admins have implicit full access to every resource in the org.
2. `viewer` / `editor` / `manager` are enough for v1.
3. Adding an object to a plugin only requires edit rights on the plugin.
4. Connector-created objects should attribute creation to the relevant connector/mapping creator, then follow normal object permissions.
5. Plugin delivery checks plugin access, not per-item access.
6. A user can access a config object if they are directly granted, team-granted, org-wide granted, or it is included in a plugin they can access.
7. Default grants for connector auto-created objects should go to the creator.
8. Config objects and plugins are private by default.
9. Sharing with the whole org should be represented as one org-wide grant, not per-user entries.
10. Member and team sharing should continue to use explicit grant rows.

## Discussion questions

These are the main questions still worth answering next.

1. Should binding a connector mapping to a plugin require edit rights on both the connector instance and the plugin?
2. Should connector-instance managers automatically receive grants on connector-created objects, or only the original creator plus normal explicit grants?
3. Should plugin managers be able to include any visible object in a plugin, or only objects they can directly edit/view?
4. Should there be extra restrictions on who can manage access for encrypted/high-sensitivity object types like MCPs?
