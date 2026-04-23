# GitHub Repo Discovery Plan

## Goal

Define the discovery phase that happens after a user connects a GitHub repo and returns to Den Web.

This phase should:

1. inspect the connected repository structure;
2. determine whether the repo is a Claude-compatible marketplace repo, a Claude-compatible single-plugin repo, or a looser folder-based repo;
3. present the discovered plugins to the user in a setup flow;
4. let the user choose which discovered plugins should map into OpenWork;
5. translate the selected discovery result into OpenWork connector records and future ingestion work.

This document covers:

- the discovery UX;
- the GitHub-side reads we need;
- how we detect supported repo shapes;
- how we infer plugins when no manifest exists;
- how the result maps into OpenWork internal structures.

Related:

- `prds/new-plugin-arch/github-connection/plan.md`
- `prds/new-plugin-arch/github-connection/connectors.md`
- `prds/new-plugin-arch/GitHub-connector.md`

## Why a discovery phase exists

The current post-connect flow stops at repository selection.

That is enough to create:

- a `connector_account`;
- a `connector_instance`;
- a `connector_target`;
- webhook-triggered `connector_sync_event` rows.

It is not enough to understand the shape of the repo and convert that shape into useful OpenWork mappings.

The discovery phase fills that gap.

Instead of immediately asking the user to author raw path mappings, OpenWork should first inspect the repo and propose a structured interpretation of what it found.

## Desired user flow

### Updated high-level flow

1. User connects GitHub.
2. User selects a repository.
3. OpenWork creates the connector instance and target.
4. OpenWork routes the user into a dedicated `Setup` / `Discovery` page for that connector instance.
5. OpenWork reads the repository tree and shows progress steps in the UI.
6. OpenWork classifies the repo shape.
7. OpenWork shows discovered plugins, preselected by default.
8. User confirms or deselects discovered plugins.
9. OpenWork creates the initial connector mappings and plugin records from that discovery result.
10. OpenWork is ready for initial ingestion/sync.

### User-facing setup steps

The setup page should feel like a guided scan.

Suggested steps:

1. `Reading repository structure`
2. `Checking for Claude marketplace manifest`
3. `Checking for plugin manifests`
4. `Looking for known component folders`
5. `Preparing discovered plugins`

The UI should show:

- which step is currently running;
- success/failure state per step;
- the discovered plugins list when ready;
- clear empty-state or unsupported-shape messaging when nothing useful is found.

## Reference conventions

### Official Claude plugin conventions

Based on the Claude plugin docs and reference repo:

- plugin manifest lives at `.claude-plugin/plugin.json`;
- marketplace manifest lives at `.claude-plugin/marketplace.json`;
- plugin components live at the plugin root, not inside `.claude-plugin/`;
- common plugin root folders include:
  - `skills/`
  - `commands/`
  - `agents/`
  - `hooks/`
  - `.mcp.json`
  - `.lsp.json`
  - `monitors/`
  - `settings.json`
- standalone Claude configuration can also live under `.claude/`, especially:
  - `.claude/skills/`
  - `.claude/agents/`
  - `.claude/commands/`

### Reference repo

Use `https://github.com/anthropics/claude-plugins-official` as a reference shape for marketplace repos.

Important observations:

- the repo has a root `.claude-plugin/marketplace.json`;
- it contains multiple plugin entries;
- many entries point at local paths inside the repo such as `./plugins/...` or `./external_plugins/...`;
- some entries point at external git URLs or subdirs.

That means OpenWork discovery should treat marketplace repos as a first-class shape, but be explicit about what is in-scope for a connected single repo.

## Discovery output model

The discovery phase should produce an explicit, structured result.

Suggested conceptual result:

```ts
type RepoDiscoveryResult = {
  connectorInstanceId: string
  connectorTargetId: string
  repositoryFullName: string
  ref: string
  treeSummary: {
    scannedEntryCount: number
    truncated: boolean
    strategy: "git-tree-recursive" | "contents-bfs"
  }
  classification:
    | "claude_marketplace_repo"
    | "claude_multi_plugin_repo"
    | "claude_single_plugin_repo"
    | "folder_inferred_repo"
    | "unsupported"
  discoveredPlugins: DiscoveredPlugin[]
  warnings: DiscoveryWarning[]
}

type DiscoveredPlugin = {
  key: string
  sourceKind:
    | "marketplace_entry"
    | "plugin_manifest"
    | "standalone_claude"
    | "folder_inference"
  rootPath: string
  displayName: string
  description: string | null
  selectedByDefault: boolean
  manifestPath: string | null
  componentKinds: Array<"skill" | "command" | "agent" | "hook" | "mcp_server" | "lsp_server" | "monitor" | "settings">
  componentPaths: {
    skills: string[]
    commands: string[]
    agents: string[]
    hooks: string[]
    mcpServers: string[]
    lspServers: string[]
    monitors: string[]
    settings: string[]
  }
  metadata: Record<string, unknown>
}
```

This result is intentionally separate from final ingestion. Discovery should be cheap to recompute and safe to show in the UI.

## API surface

## Requirements

We need an API that can, given the selected connector instance/target, read GitHub and return a normalized view of the repository tree and discovery result.

The tree can be large, so the API must not assume that the full repo listing is always tiny.

### Recommended endpoints

#### 1. Start or refresh discovery

`POST /v1/connector-instances/:connectorInstanceId/discovery/refresh`

Purpose:

- read GitHub using the installation token;
- build or refresh the discovery snapshot;
- persist the result for the UI;
- return the current discovery state.

Recommended response:

- current step/state;
- summary counts;
- discovered plugins if already complete.

#### 2. Get discovery state

`GET /v1/connector-instances/:connectorInstanceId/discovery`

Purpose:

- return the last computed discovery result;
- support polling while the discovery scan runs;
- drive the setup page without recomputing every request.

#### 3. Page through the normalized repo tree

`GET /v1/connector-instances/:connectorInstanceId/discovery/tree?cursor=&limit=&prefix=`

Purpose:

- expose the discovered file list for debugging and future advanced UX;
- avoid forcing the UI to load every path at once;
- support drill-down into a directory prefix.

### Why a persisted snapshot is better than live-only reads

Discovery is more than a raw file listing.
It is a structured interpretation step.

Persisting the latest snapshot gives us:

- deterministic UI reload behavior;
- auditability of what the repo looked like when discovery ran;
- a clean handoff from discovery UI to mapping creation;
- a place to store warnings and unsupported cases.

## GitHub reading strategy

### Primary strategy

Use the GitHub Git Trees API against the selected branch head commit.

Preferred read path:

1. fetch the tracked branch head SHA;
2. fetch the recursive tree for that commit;
3. normalize to a path list with type metadata.

Advantages:

- one request gives the full tree in the common case;
- easy to search for known files;
- easy to infer folder groupings;
- deterministic against a known commit SHA.

### Fallback strategy for large repos

GitHub recursive tree responses can be truncated.

If the recursive tree response is truncated:

1. store that truncated flag;
2. fall back to directory-by-directory `contents` traversal using BFS;
3. page the normalized result by `prefix + cursor`;
4. cap the total scan budget for one discovery run.

### Suggested limits

For v1:

- default API page size: `200` normalized entries;
- default max discovery scan budget: `10,000` paths;
- stop scanning further when:
  - we exceed budget;
  - or we have enough evidence to classify the repo and build the discovered plugin list.

### Practical optimization

We do not need the full contents of every file during discovery.

We mostly need:

- the path list;
- whether certain files exist;
- the content of a small number of manifest files.

So discovery should:

- list tree entries first;
- only fetch file contents for:
  - `.claude-plugin/marketplace.json`
  - any `.claude-plugin/plugin.json`
  - any root-level `plugin.json` used as a metadata hint
  - `.mcp.json`
  - `.lsp.json`
  - `hooks/hooks.json`
  - `monitors/monitors.json`
  - `settings.json`

Do not eagerly fetch SKILL/agent/command content during the discovery phase.

## Classification algorithm

Discovery should classify the repo in this priority order.

### 1. Marketplace repo

Check for root:

- `.claude-plugin/marketplace.json`

If present:

- classify as `claude_marketplace_repo`;
- parse marketplace entries;
- attempt to resolve entries that point to local repo paths;
- present the listed plugins to the user, ticked by default.

### 2. Explicit plugin manifests

If no marketplace manifest exists, search for all instances of:

- `.claude-plugin/plugin.json`

If one or more are found:

- classify as:
  - `claude_single_plugin_repo` if exactly one plugin manifest exists and it is at repo root;
  - `claude_multi_plugin_repo` if more than one plugin manifest exists or plugin roots live in subdirectories.
- create one `DiscoveredPlugin` per manifest.

### 3. Standalone Claude folders

If no marketplace manifest and no plugin manifest is found, check for standalone Claude paths:

- `.claude/skills/**`
- `.claude/commands/**`
- `.claude/agents/**`

If present:

- classify as `standalone_claude` in the discovered plugin source kind;
- infer a single plugin rooted at repo root unless stronger folder grouping is present.

### 4. Folder inference

If none of the explicit Claude shapes exist, infer plugin candidates from known component folders.

Known folders:

- `skills/`
- `commands/`
- `agents/`

Rule:

- for each match, examine its parent folder;
- group sibling component folders by that parent;
- create one discovered plugin per parent folder.

Example:

```text
Sales/skills
Sales/commands
finance/agents
finance/commands
```

Discovery result:

- plugin `Sales`
- plugin `finance`

This becomes:

- one plugin candidate rooted at `Sales/`
- one plugin candidate rooted at `finance/`

If the repo itself has root-level `skills/`, `commands/`, or `agents/`, that should infer one root plugin using the repo name as the display name unless better metadata exists.

## Plugin metadata resolution

For each discovered plugin candidate, resolve metadata in this order.

### 1. Official Claude plugin manifest

Check:

- `<root>/.claude-plugin/plugin.json`

If present, use:

- `name`
- `description`
- `version`
- `author`
- other supported metadata as hints

### 2. Loose metadata hint

If no official manifest exists, optionally check:

- `<root>/plugin.json`

This is not an official Claude plugin location.
Treat it as a metadata hint only.

Use:

- `name`
- `description`

Do not treat it as proof that the repo is a Claude plugin.

### 3. Folder-name fallback

If no metadata file exists:

- use the folder name as `displayName`;
- derive a human-friendly label from that folder name.

For a root plugin with no folder name beyond the repo itself, use the repo name.

## Marketplace repo handling

Marketplace repos need special treatment.

### What we should support in v1

Support marketplace entries whose source resolves inside the currently connected repo.

Examples:

- `./plugins/example-plugin`
- `./external_plugins/something`

For these entries:

- resolve the local plugin root;
- inspect that root for components;
- create one `DiscoveredPlugin` for each entry.

### What we should not silently fake in v1

Marketplace entries that point to external URLs or other repos should not be treated as if they were fully present in the current repo.

Examples:

- `source.url = https://github.com/...`
- `source.source = git-subdir`

For those entries, discovery should either:

- mark them as `external source not yet supported in repo discovery`; or
- hide them unless we explicitly decide to support cross-repo expansion.

Recommended v1 behavior:

- show them in the discovery result but disable selection;
- explain that they require external source expansion, which is out of scope for the current single-repo connector flow.

This keeps the behavior honest and still lets users understand what OpenWork detected.

## Inferred plugin rules

### Known component directories

The discovery system should recognize these as plugin-like components:

- `skills/`
- `commands/`
- `agents/`
- `.claude/skills/`
- `.claude/commands/`
- `.claude/agents/`

Optional later additions:

- `hooks/`
- `.mcp.json`
- `.lsp.json`
- `monitors/`
- `settings.json`

### Grouping rules

Group by the nearest plugin root candidate.

Examples:

#### Case A: explicit manifest

```text
plugins/sales/.claude-plugin/plugin.json
plugins/sales/skills
plugins/sales/commands
```

Result:

- one discovered plugin rooted at `plugins/sales`

#### Case B: inferred sibling grouping

```text
Sales/skills
Sales/commands
Finance/agents
Finance/commands
```

Result:

- one discovered plugin rooted at `Sales`
- one discovered plugin rooted at `Finance`

#### Case C: root standalone repo

```text
.claude/skills
.claude/commands
```

Result:

- one discovered plugin rooted at repo root

## UI plan

## Setup page states

Suggested states:

1. `loading`
2. `discovery_running`
3. `discovery_ready`
4. `discovery_empty`
5. `discovery_error`

### discovery_running

Show:

- progress steps;
- current repo name/branch;
- a short explanation that OpenWork is figuring out how to map this repo.

### discovery_ready

Show:

- discovered plugins list;
- each item ticked by default if supported;
- description/metadata when available;
- badges for detected component kinds:
  - skills
  - commands
  - agents
  - hooks
  - MCP
- warnings for unsupported marketplace entries or ambiguous structure.

Primary CTA:

- `Continue with selected plugins`

Secondary CTA:

- `Review file structure`

### discovery_empty

Show:

- no supported plugin structure found;
- what OpenWork looked for;
- option to create manual mappings.

### discovery_error

Show:

- discovery failed;
- which step failed;
- retry action.

## What the user selects

The user should select plugin groups, not raw files.

Each selected discovered plugin becomes a proposal for:

- one OpenWork `plugin` row;
- a set of `connector_mapping` rows covering that plugin's component folders.

This matches the product goal better than asking the user to map individual folders one by one on first run.

## Mapping discovered plugins to OpenWork internal data

## Internal objects we already have

- `connector_account`
- `connector_instance`
- `connector_target`
- `connector_mapping`
- `connector_sync_event`
- `connector_source_binding`
- `connector_source_tombstone`
- `plugin`
- plugin membership tables
- `config_object`

## Discovery-to-internal mapping

### Discovery phase output

Before the user confirms selection, discovery should exist as draft state.

Recommended persistence model:

- `connector_discovery_run`
- `connector_discovery_candidate`

Conceptually:

```text
connector_discovery_run
- id
- organization_id
- connector_instance_id
- connector_target_id
- source_revision_ref
- status
- classification
- tree_summary_json
- warnings_json
- created_at
- updated_at

connector_discovery_candidate
- id
- discovery_run_id
- key
- source_kind
- root_path
- display_name
- description
- manifest_path
- component_summary_json
- selection_state
- supported
- warnings_json
```

Why add dedicated discovery tables instead of jumping straight to `connector_mapping`?

- discovery is provisional;
- the user may deselect some plugin candidates;
- we want to store unsupported candidates and warnings;
- we want a clean boundary between `what we saw` and `what the user approved`.

### After user confirms selection

For each selected discovered plugin:

1. create or upsert an OpenWork `plugin` row;
2. create one `connector_mapping` per detected component kind/path;
3. set `auto_add_to_plugin = true` for those mappings;
4. link the mapping to the selected OpenWork plugin id;
5. enqueue an initial discovery-approved ingestion sync.

### Example mapping

Repo:

```text
Sales/skills
Sales/commands
finance/agents
finance/commands
```

Discovery result:

- plugin candidate `Sales`
- plugin candidate `finance`

Internal translation after user confirms:

- create OpenWork plugin `Sales`
- create OpenWork plugin `finance`
- create mappings:
  - `Sales/skills/**` -> `skill` -> plugin `Sales`
  - `Sales/commands/**` -> `command` -> plugin `Sales`
  - `finance/agents/**` -> `agent` -> plugin `finance`
  - `finance/commands/**` -> `command` -> plugin `finance`

### Marketplace mapping

For a local marketplace entry rooted at `plugins/feature-dev`:

- create one OpenWork plugin from the marketplace/plugin metadata;
- create mappings for each detected component path under that root;
- preserve the marketplace entry metadata as origin/discovery metadata.

## Discovery does not ingest content yet

Discovery should stop short of full content ingestion.

It should:

- inspect paths;
- read manifests and small metadata files;
- infer plugin groups;
- help the user approve a mapping shape.

It should not yet:

- parse every SKILL/agent/command file body;
- create `config_object` rows;
- create `connector_source_binding` rows;
- create tombstones.

Those belong to the subsequent ingestion/reconciliation phase.

## Relationship to initial sync

The initial sync should happen after discovery is approved.

Suggested flow:

1. repo selected
2. connector instance created
3. discovery run computes candidates
4. user confirms selections
5. OpenWork creates plugin rows + connector mappings
6. OpenWork enqueues initial full sync
7. sync executor reads repo contents and materializes config objects

This sequencing is important because ingestion needs the mapping decisions.

## v1 scope

### In scope

- dedicated setup/discovery page after repo selection;
- repo tree listing API with pagination/limits;
- root marketplace detection;
- `.claude-plugin/plugin.json` discovery anywhere in the repo;
- `.claude/skills`, `.claude/commands`, `.claude/agents` support;
- folder-based inference from known component paths;
- user selection UI for discovered plugins;
- translation from selected candidates into plugin rows + connector mappings.

### Explicitly out of scope for this phase

- full content ingestion;
- recursive external marketplace source expansion across other repos;
- hooks-to-OpenWork runtime semantics beyond discovery;
- automatic parsing of every skill/agent/command file body during discovery.

## Open questions

1. Should discovery run synchronously for small repos and asynchronously for larger repos, or always be modeled as a background run?
2. Do we want to persist discovery results in dedicated tables immediately, or temporarily store the first version inside connector metadata while the shape is still changing?
3. For marketplace repos with external URL entries, should we show unsupported entries disabled, or hide them entirely in v1?
4. Should root-level `plugin.json` remain a metadata hint only, or do we want to formalize it as an OpenWork-specific compatibility rule?
5. When multiple discovered plugin candidates have the same normalized name, what is the preferred display/slug collision strategy?

## Recommended next implementation order

1. Add a discovery result model and API endpoints.
2. Implement GitHub tree listing with truncation-aware fallback.
3. Implement classification + candidate extraction.
4. Update the GitHub setup page to become the discovery page.
5. Add the discovered plugin selection UI.
6. Convert approved candidates into `plugin` + `connector_mapping` rows.
7. Then implement initial ingestion against those mappings.
