# Config Types

These docs describe the unique data shape for each supported config type in the new plugin architecture.

They build on the shared model in `prds/new-plugin-arch/datastructure.md`:

- `config_object` = current searchable projection
- `config_object_version` = immutable history and latest-version source of truth

Related API design:

- `prds/new-plugin-arch/api.md`

Type-specific docs:

- `prds/new-plugin-arch/config-types/skills.md`
- `prds/new-plugin-arch/config-types/agents.md`
- `prds/new-plugin-arch/config-types/commands.md`
- `prds/new-plugin-arch/config-types/tools.md`
- `prds/new-plugin-arch/config-types/mcps.md`

Recommended pattern across all types:

- keep one shared `config_object` / `config_object_version` backbone;
- project current, queryable metadata onto `config_object`;
- preserve the raw source artifact on `config_object_version`;
- encrypt key payload/content columns at rest across all config types;
- keep friendly metadata like `title` and `description` plaintext when needed for dashboard display and search;
- add one type-specific current projection table per type when the shape is meaningfully different or needs fast filtering.
