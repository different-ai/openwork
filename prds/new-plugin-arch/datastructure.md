# New Plugin Arch Data Structure

This document holds the proposed data model and schema direction for the new plugin architecture.

It is intentionally separate from `prds/new-plugin-arch/plan.md` so the plan can stay focused on product direction and architectural decisions while this file captures implementation-oriented structure.

Type-specific shape docs live in:

- `prds/new-plugin-arch/config-types/README.md`

API design lives in:

- `prds/new-plugin-arch/api.md`

RBAC design lives in:

- `prds/new-plugin-arch/rbac.md`

## Guiding rules

- config objects are first-class and versioned;
- plugins link to config object identities, never directly to object versions;
- plugin resolution always uses the latest active object version;
- latest version is derived from `config_object_version` ordering, not stored separately on `config_object`;
- key config payload/data columns should be encrypted at rest;
- friendly current metadata like `title` and `description` can remain plaintext for UI and search;
- connector provenance is stored explicitly;
- deletes are soft and path tombstones are preserved for connector-managed items;
- RBAC shape should stay consistent across config objects, plugins, and connectors.

## Core tables

### `config_object`

Stable identity row for one logical config object.

Suggested columns:

- `id`
- `organization_id`
- `object_type` (`skill`, `mcp`, `command`, `agent`, `hook`, `context`, `custom`)
- `source_mode` (`cloud`, `import`, `connector`)
- `title`
- `description` nullable
- `search_text` nullable
- `slug` or stable org-local key if needed
- `current_file_name` nullable
- `current_file_extension` nullable
- `current_relative_path` nullable
- `status` (`active`, `inactive`, `deleted`, `archived`, `ingestion_error`)
- `created_by_org_membership_id`
- `connector_instance_id` nullable
- `created_at`
- `updated_at`
- `deleted_at` nullable

Notes:

- this is the row plugins reference;
- this is also the row current search and dashboard queries should hit;
- title/description on this row are the current projection derived from the latest version, not an independent historical source of truth;
- `title`, `description`, and `search_text` may remain plaintext because they are intended for dashboard rendering and search;
- `updated_at` is convenience metadata only and should not be treated as the source of truth for latest version resolution;
- connector-managed objects still use the same identity table.

### `config_object_version`

Immutable content/history row for each version of a config object.

Suggested columns:

- `id`
- `config_object_id`
- `normalized_payload_json`
- `raw_source_text` nullable
- `schema_version` or parser version nullable
- `created_via` (`cloud`, `import`, `connector`, `system`)
- `created_by_org_membership_id` nullable
- `connector_sync_event_id` nullable
- `source_revision_ref` nullable
- `is_deleted_version` boolean default false
- `created_at`

Notes:

- object-type-specific fields should generally live in payload JSON, not as many sparse columns on the shared table;
- version rows should not be the primary surface for current library search because that would create duplicate hits across historical versions of the same object;
- a deleted source file can create a terminal deleted version while leaving the identity row intact;
- `normalized_payload_json`, `raw_source_text`, and any equivalent key content columns for config objects should be encrypted at rest;
- `config_object_version` is the single source of truth for version history and latest-version lookup.

Current metadata projection rule:

- after creating a new latest version, parse whatever title/description/friendly metadata can be derived from that version and write the current projection onto the parent `config_object` row;
- current dashboard/search experiences should query `config_object`, not `config_object_version`.

Suggested index:

- (`config_object_id`, `created_at` DESC, `id` DESC)

Latest lookup rule:

- latest version for an object = newest row for that `config_object_id`, ordered by `created_at DESC, id DESC`.
- `created_at` should be database-generated so ordering stays authoritative.

Version number note:

- v1 does not require a separate version-number column on `config_object_version`;
- immutable ids plus `created_at` are enough for history and latest-version resolution;
- add a human-facing version number later only if product UX needs ordered revision labels.

Metadata extraction note:

- some config types derive title/description from file contents, such as skill frontmatter;
- other config types may derive friendly metadata from file name, path, or type-specific parsing rules;
- type-specific extraction rules should run when projecting the latest version onto `config_object`.

### `plugin`

Stable deliverable row.

Suggested columns:

- `id`
- `organization_id`
- `name`
- `description`
- `status`
- `created_by_org_membership_id`
- `created_at`
- `updated_at`
- `deleted_at` nullable

Notes:

- a plugin is the administrator-facing unit of delivery;
- a plugin contains config object identities, not pinned content versions;
- when resolving a plugin, the system selects the newest version row for each linked object.

### `plugin_config_object`

Membership join between plugins and config object identities.

Suggested columns:

- `id`
- `plugin_id`
- `config_object_id`
- `membership_source` (`manual`, `connector`, `api`, `system`)
- `connector_mapping_id` nullable
- `created_by_org_membership_id` nullable
- `created_at`
- `removed_at` nullable

Constraints:

- unique active membership on (`plugin_id`, `config_object_id`)

Notes:

- current implementation keeps one logical membership row per (`plugin_id`, `config_object_id`) and uses `removed_at` for soft removal/reactivation rather than append-only history rows;
- if an object later becomes deleted, the membership row can remain while delivery skips that object.

## Access and RBAC tables

We want the same RBAC model across config objects, plugins, and connectors.

There are two realistic schema options:

1. Separate access tables per resource type
   - better foreign keys
   - more repeated schema
2. One generic access table
   - easier shared logic
   - weaker relational guarantees

Current recommendation:

- start with separate tables that share the same shape.

### `plugin_access_grant`

Suggested columns:

- `id`
- `plugin_id`
- `org_membership_id` nullable
- `team_id` nullable
- `org_wide` boolean default false
- `role` or `permission_level`
- `created_by_org_membership_id`
- `created_at`
- `removed_at` nullable

### `config_object_access_grant`

Same shape as plugin access, but scoped to `config_object_id`.

### `connector_instance_access_grant`

Same shape as plugin access, but scoped to `connector_instance_id`.

RBAC note:

- plugin delivery may be implemented primarily by plugin access grants;
- if a team has access to a plugin, that is effectively the publish step.
- config objects and plugins should be private by default;
- sharing with the whole org should be represented as one org-wide grant, not per-user entries.
- use `org_wide = true` for v1.
- member and team sharing should continue to use normal explicit grant rows.
- current implementation also uses one logical grant row per target principal and reactivates it by clearing `removed_at`.

## Connector tables

### `connector_account`

Represents one authenticated or installed connector relationship.

Examples:

- one GitHub App installation
- one future API credential binding

Suggested columns:

- `id`
- `organization_id`
- `connector_type` (`github`, etc.)
- `remote_id`
- `external_account_ref`
- `display_name`
- `status`
- `created_by_org_membership_id`
- `created_at`
- `updated_at`

Notes:

- secrets should stay out of git-backed repo files and remain private;
- `id` is OpenWork's local primary key, while `remote_id` is the stable connector-side identifier we can use across different connector families;
- this row is the reusable "one-time setup" layer.

### `connector_instance`

Represents one configured use of a connector account.

Examples:

- a GitHub repo + branch configuration
- a future API collection endpoint mapping

Suggested columns:

- `id`
- `organization_id`
- `connector_account_id`
- `connector_type`
- `remote_id` nullable
- `name`
- `status`
- `instance_config_json`
- `last_synced_at` nullable
- `last_sync_status` nullable
- `last_sync_cursor` nullable
- `created_by_org_membership_id`
- `created_at`
- `updated_at`

Notes:

- one connector instance may feed multiple plugins;
- one plugin may include objects from multiple connector instances;
- one connector instance may ingest objects without direct plugin auto-membership;
- `remote_id` is optional here because some connector instances may not map cleanly to one remote object, while others will.

### `connector_target`

Represents the external source target inside an instance.

Examples:

- repo owner/name
- branch
- API endpoint family
- collection identifier

Suggested columns:

- `id`
- `connector_instance_id`
- `connector_type`
- `remote_id`
- `target_kind`
- `external_target_ref`
- `target_config_json`
- `created_at`
- `updated_at`

Notes:

- this table lets us support git and non-git connectors with one shared abstraction;
- `remote_id` should be the canonical external identifier for the target, such as `org/repo` for GitHub repo targets.

### `connector_mapping`

Maps part of a connector target into a config object type and optional plugin behavior.

Suggested columns:

- `id`
- `connector_instance_id`
- `connector_target_id`
- `connector_type`
- `remote_id` nullable
- `mapping_kind` (`path`, `api`, `custom`)
- `selector`
- `object_type`
- `plugin_id` nullable
- `auto_add_to_plugin` boolean
- `mapping_config_json`
- `created_at`
- `updated_at`

Examples:

- selector `/sales/skills/**` -> `skill` -> plugin A
- selector `/sales/commands/**` -> `command` -> plugin A
- selector `/finance/skills/**` -> `skill` -> plugin B

Notes:

- this is the row that captures the default parent-path -> plugin behavior;
- advanced/manual plugins can still include connector-managed objects outside this automatic mapping;
- `remote_id` can be used if a connector exposes mapping-level remote identifiers, but it is optional.

### `connector_sync_event`

Audit row for each webhook/poll/sync execution.

Suggested columns:

- `id`
- `connector_instance_id`
- `connector_target_id` nullable
- `connector_type`
- `remote_id` nullable
- `event_type`
- `external_event_ref` nullable
- `source_revision_ref` nullable
- `status`
- `summary_json`
- `started_at`
- `completed_at` nullable

Notes:

- useful for debugging, replay decisions, and ingestion history;
- for GitHub this should also capture delivery ids and head commit SHAs inside `summary_json` or promoted columns if we need faster filtering.

### `connector_source_binding`

Links a live config object identity to its external source location.

Suggested columns:

- `id`
- `config_object_id`
- `connector_instance_id`
- `connector_target_id`
- `connector_mapping_id`
- `connector_type`
- `remote_id` nullable
- `external_locator`
- `external_stable_ref` nullable
- `last_seen_source_revision_ref` nullable
- `status`
- `created_at`
- `updated_at`
- `deleted_at` nullable

Examples of `external_locator`:

- repo path
- API resource id
- remote document key

Notes:

- one live object should normally have one active source binding;
- this is how we know which external path/resource created the object;
- `remote_id` can hold a stable connector-native file/resource id when the remote system provides one.

### `connector_source_tombstone`

Preserves deleted source locations so we do not accidentally revive old identities.

Suggested columns:

- `id`
- `connector_instance_id`
- `connector_target_id`
- `connector_mapping_id`
- `connector_type`
- `remote_id` nullable
- `external_locator`
- `former_config_object_id`
- `deleted_in_sync_event_id`
- `deleted_source_revision_ref` nullable
- `created_at`

Notes:

- if the same path later reappears, ingestion creates a new config object identity;
- this table prevents accidental reconnect of a recreated file to an old object.

## Optional release/install tables

We have not finalized delivery yet, but these are likely candidates.

### `plugin_release`

Optional first-class release/snapshot row for a plugin.

Suggested columns:

- `id`
- `plugin_id`
- `release_kind` (`manual`, `system`, `access_change`, `sync_snapshot`)
- `created_by_org_membership_id` nullable
- `created_at`
- `notes` nullable

### `plugin_release_item`

Snapshot of the config object versions included at release time.

Suggested columns:

- `id`
- `plugin_release_id`
- `config_object_id`
- `config_object_version_id`
- `created_at`

Notes:

- even if runtime delivery is rolling latest, these tables can still be useful for audit, rollback, and support;
- if we decide releases are unnecessary, these tables can be deferred.

## Suggested write patterns

### Creating a new cloud/import object

1. insert `config_object`
2. insert first `config_object_version`
3. parse current metadata from that version and update `config_object.title`, `description`, `search_text`, and any current file metadata
4. optionally update `config_object.updated_at`
5. optionally insert `plugin_config_object`

### Connector sync updating an existing object

1. create `connector_sync_event`
2. locate active `connector_source_binding`
3. insert new `config_object_version`
4. parse current metadata from that version and update the parent `config_object` projection
5. optionally update `config_object.updated_at`
6. update `connector_source_binding.last_seen_source_revision_ref`

### Connector sync deleting an object

1. create deleted `config_object_version` or mark identity status as deleted
2. update `config_object.status` and clear or adjust current searchable projection as needed
3. close `connector_source_binding`
4. insert `connector_source_tombstone`
5. keep `plugin_config_object` history intact

## Latest-version strategy

To keep one source of truth and avoid out-of-date derived state, we should not store `latest_version_id` on `config_object` in v1.

Instead:

- treat `config_object_version` as the only source of truth for version ordering;
- determine latest by query using `created_at DESC, id DESC`;
- keep version rows immutable.

Example lookup pattern:

```sql
select v.*
from config_object co
join config_object_version v on v.config_object_id = co.id
where co.id = ?
order by v.created_at desc, v.id desc
limit 1;
```

Why this is the current recommendation:

- no duplicated latest-version pointer to drift out of sync;
- no revision counter race condition;
- simple write path;
- acceptable read cost given expected version counts and proper indexing;
- current library search can still stay fast because it queries `config_object`, not historical versions.

Future option:

- if reads later prove too expensive, we can add a derived latest pointer as an optimization, but not as the authoritative source of truth.

## Current schema recommendation

If we had to start implementation now, the minimum useful table set would be:

- `config_object`
- `config_object_version`
- `plugin`
- `plugin_config_object`
- `plugin_access_grant`
- `connector_account`
- `connector_instance`
- `connector_target`
- `connector_mapping`
- `connector_sync_event`
- `connector_source_binding`
- `connector_source_tombstone`
