# New Plugin Arch

This document is a working architecture draft for the next-generation shared config system.

## Purpose

Replace the current skill hub model with a more general plugin system that can:

- manage many config object types, not just skills;
- ingest config objects from multiple sources, including cloud-native editing, imports, and connectors;
- package those objects into deliverables called plugins;
- apply one consistent RBAC model across objects, plugins, and connectors;
- preserve source-of-truth and version provenance, especially for connector-managed content.

## Core Concepts

### Config object

A config object is a single installable unit of product configuration.

Planned object types:

- Skill
- MCP
- Command
- Agent
- Hook
- Context
- Custom

Notes:

- Each type has its own shape and validation rules.
- Each type may install differently on the client.
- Each object needs a stable identity that survives edits and version changes.

### Tags (deferred)

We are removing config object groups from the v1 design.

Possible future direction:

- add a tag system later for organization and filtering.

### Plugin

A plugin is a deliverable made from:

- config objects.

Key idea:

- administrators assemble plugins as the unit that is delivered to users.

Plugins replace the current mental model of a hub.

### Marketplace

A marketplace is an organization-scoped grouping of plugins.

Key idea:

- administrators can curate multiple marketplaces per org;
- each marketplace contains zero or more plugins;
- marketplace access controls discovery and delivery at a higher level than individual plugins;
- plugin-level access can still exist for direct sharing or exceptions.

## Source Model

Config objects may be created or updated from multiple source channels:

- Cloud: created or edited directly in OpenWork Cloud.
- Import: created from uploaded/imported material.
- Connector: created and updated from an external system.

### Source ownership rule

If an object is created by a connector, it is only editable through that connector.

Implications:

- cloud/import objects are first-party editable in OpenWork;
- connector-managed objects may still be editable in OpenWork by users with permission, but connector sync remains authoritative and may overwrite content on the next sync;
- OpenWork must keep enough source metadata to re-ingest, reconcile, audit, and display provenance.

## Connector Model

Connectors are reusable integrations that ingest config objects from external systems.

Examples:

- GitHub
- future git-based providers
- future API-based providers
- future non-file-based providers

### Connector layers

There appear to be at least two layers:

1. Connector type
   - the implementation family, such as GitHub.
2. Connector configuration / instance
   - a specific configured connection, such as one GitHub app installation plus repo/branch/mapping settings.

The current working direction is:

- one-time setup for a connector;
- per-instance configuration for a repo or external resource;
- that configured connector can then be tied to one or more plugins, or to config objects without an auto-managed plugin.

### GitHub example

For GitHub, the likely model is:

- a GitHub App is installed on a repo or org;
- OpenWork stores the repo binding;
- the user configures the branch to watch;
- the user configures path mappings from source paths to config object types;
- webhook events trigger ingestion and reconciliation.

Examples of mappings:

- `/bundles/skills/**` -> `skill`
- `/bundles/agents/**` -> `agent`

### Connector mapping responsibilities

A configured connector likely needs:

- source kind, such as `github`;
- source-specific config, such as branch;
- path or API mappings;
- plugin binding information;
- ingestion mode and parser rules;
- webhook or polling state;
- last successful sync state.

### Connector-to-plugin behavior

Current direction:

- one connector instance may feed multiple plugins;
- one plugin may include objects from multiple connector instances;
- one connector instance may also ingest objects without directly feeding a plugin;
- plugin membership may be manually edited even when some members originated from connectors.

Default UX direction:

- setup should offer one plugin per parent path;
- if `/sales/skills` maps to plugin A, then sibling mapped paths under that same parent should default to the same plugin rather than splitting automatically;
- a different parent path such as `/finance/skills` may map to a different plugin;
- advanced/manual plugin composition may still exist outside the default connector setup flow.

### File lifecycle behavior

For file-backed connectors:

- new file -> create new config object and add it to the bound plugin automatically;
- changed file -> create a new version or revision of the existing object;
- deleted file -> mark the current object as deleted on our side, but do not hard-delete it;
- recreated file at the same path -> create a new object identity rather than reviving the deleted one.

Important nuance:

- once a file-backed object is deleted, we should preserve historical path linkage, but we should not continue updating that deleted object if a file later reappears.

## Proposed Domain Model

### Stable identity layer

We likely need a stable identity table for each logical config object, separate from versioned content rows.

Why:

- plugins should point at stable identities, not at a mutable single content row;
- source ownership and provenance belong to the logical object;
- installation tracking likely belongs to the logical object plus a chosen version;
- object history becomes easier to preserve.

Minimum identity-layer responsibilities:

- stable id;
- org id;
- object type;
- source mode (`cloud`, `import`, `connector`);
- current title / friendly name;
- current description;
- connector instance reference if applicable;
- current file metadata where relevant;
- created by / created at;
- last updated at;
- lifecycle status.

### Version layer

Each edit or connector sync likely creates a new object version row.

Version rows would likely hold:

- version id;
- parent object id;
- parsed metadata for indexing;
- raw source payload or normalized payload;
- source revision reference such as commit SHA, webhook delivery id, or external version token;
- created at;
- created by or created via;
- deletion marker if the version represents removal.

Current open decision:

- whether we ever need human-facing revision numbers beyond immutable version ids plus timestamps.

Current leaning:

- we do want durable history and a clear latest version model;
- for v1, newest-created version is an acceptable latest-version rule if the database owns `created_at` and we use `id` as a tie-breaker;
- external source references like commit SHA should still be stored separately;
- implementation should prefer one source of truth over duplicated latest-version state;
- searchable current metadata should live on the parent object so dashboard queries do not scan historical versions and return duplicates.

### Plugin layer

Plugins likely need:

- stable id;
- org id;
- metadata;
- lifecycle status;
- membership rows pointing to config object identities;
- optional connector bindings if the plugin is connector-managed.

Important:

- plugin membership should preserve historical links even if an included object later becomes deleted or inactive;
- plugins reference config object identities, not pinned versions;
- plugin delivery resolves the latest version of each linked object;
- delivery logic can decide whether deleted items are omitted from downloads.

### Marketplace layer

Marketplaces likely need:

- stable id;
- org id;
- metadata;
- lifecycle status;
- membership rows pointing to plugins;
- access grants for member/team/org-wide visibility.

Important:

- orgs can have multiple marketplaces;
- a plugin may belong to multiple marketplaces;
- marketplace membership should preserve history even when a plugin is later archived or removed;
- marketplace access should provide view/discovery access to included plugins without automatically granting plugin edit rights.

## RBAC Direction

RBAC should be consistent across:

- config objects;
- plugins;
- marketplaces;
- connectors.

We will likely need separate permission families for:

- creating config objects manually;
- editing cloud/import-managed objects;
- creating plugins;
- creating marketplaces;
- attaching objects to plugins;
- attaching plugins to marketplaces;
- creating connector definitions;
- configuring connector instances;
- binding connector instances to plugins;
- approving connector ingestion or sync behavior;
- managing delivery visibility to users.

Open question:

- plugin "publish/release" may not be a separate workflow; in practice, delivery may just mean changing access permissions, such as granting a team access to a plugin.

## Provenance Requirements

We need strong provenance for connector-managed content.

At minimum, OpenWork should know:

- how the object was created;
- which connector instance created it;
- the external source address;
- the mapping that classified it;
- the external revision that produced the current local version;
- whether the object is active, deleted, stale, or out of sync.

For GitHub-like sources, we likely also need:

- app installation or account binding;
- repo owner/name;
- branch;
- path;
- commit SHA for each ingested version;
- webhook delivery or event metadata for debugging.

## Lifecycle States

We likely need soft lifecycle states instead of hard deletes.

Candidate statuses:

- active
- inactive
- deleted
- archived
- ingestion_error

Open question:

- whether `deleted` should mean source removed, while `archived` means intentionally retired by an admin.

## Compatibility With Current System

Today:

- skills are the only first-class sharable object in Den;
- hubs are team/member-access-controlled groupings of skills;
- the app downloads and installs individual skills, not durable plugin bundles.

Future:

- skills become one config object type among many;
- hubs disappear from the product model;
- plugins become the administrator-authored deliverable;
- marketplaces become the higher-level catalog/grouping surface for plugins;
- connectors can automatically populate plugins;
- delivery/install rules move up from individual skills to plugin-aware distribution.

## Data Structure

The implementation-oriented schema and data-model details now live in:

- `prds/new-plugin-arch/datastructure.md`
- `prds/new-plugin-arch/rbac.md`

That document currently captures:

- the proposed `config_object` and `config_object_version` split;
- plugin membership tables;
- marketplace membership tables;
- RBAC table direction;
- connector/account/instance/mapping/source-binding tables;
- latest-version lookup strategy;
- current metadata projection rules for dashboard search;
- optional release/install tables.

Key current data-model decisions:

- `config_object_version` is the single source of truth for version history and latest-version resolution;
- `config_object` is the current searchable projection for dashboard and library queries;
- latest version is resolved by `created_at DESC, id DESC`, not a stored latest pointer;
- v1 does not need a version-number column;
- connector source tombstones preserve deleted path history so recreated files get new identities.

## Immediate Open Questions

### Identity and typing

- Is `custom` just a catch-all typed blob, or does it need subtyping?
- Can one config object belong to many plugins? Current assumption: yes.

### Versioning

- v1 does not need explicit version numbers; immutable version ids plus `created_at` are enough.
- Do we need explicit human-facing revision numbers later for UX, debugging, or APIs?
- Plugins point to object identities and always resolve latest versions.
- Do we want plugin releases as a first-class concept separate from object versions?

### Connector ownership

- Connector-managed objects should still allow local edits for authorized users, knowing connector sync may overwrite content later.
- Membership, tags, and RBAC remain locally managed.
- Do we need conflict indicators when local edits diverge from the connector source before the next overwrite?

### Deletion and recreation

- When a connector file is deleted, should the object immediately disappear from active delivery, or remain selectable with warnings?
- If a file reappears at the same path, it should create a new object identity regardless of content.
- We likely need tombstones for deleted external paths so we do not accidentally revive prior identities.

### RBAC

- Who can create cloud-native config objects?
- Who can configure connector types vs connector instances?
- Who can bind connector instances to plugins?
- Who can override connector-derived membership or metadata?

### Default connector UX vs advanced composition

- How rigid should the default parent-path -> plugin mapping be?
- Should manual plugins be allowed to include connector-managed objects from any path even if the default setup flow keeps path families together?

### Ingestion engine

- Do we normalize all source payloads into one common schema plus type-specific payload blocks?
- How strict is validation on ingestion: reject bad files, partially ingest, or mark them errored?
- How do we surface per-file ingestion failures to admins?

### Delivery model

- Are plugins downloaded as full bundles, as selected object manifests, or as live subscriptions?
- How does install/update behavior differ by object type?
- How do clients know which version of each object or plugin they have?

## Current Recommendations

- Introduce a stable identity table plus immutable version rows for config objects.
- Treat `config_object_version` as the only source of truth for latest-version lookup in v1.
- Do not add a version-number column in v1 unless product requirements emerge for human-facing revision labels.
- Treat plugins as first-class entities with membership tables.
- Treat marketplaces as first-class entities that group plugins.
- Keep source ownership explicit on every config object identity.
- Model connectors as reusable integration definitions plus configured instances.
- Store connector provenance richly enough to debug and reconcile webhook-driven ingestion.
- Use soft deletion and preserve historical membership rather than hard-deleting rows.

## Next Discussion

Next we should define the delivery model:

- how plugins are published to users;
- whether delivery is pinned or rolling;
- how clients install/update each object type;
- how to represent client state and rollout state.
