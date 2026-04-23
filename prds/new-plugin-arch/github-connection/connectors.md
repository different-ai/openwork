# Connectors — API surface, FS convention, and lifecycle

Status: draft
Owner: src-opn
Scope: OpenWork server + Den web + OpenCode integration
Related: `/o/:slug/dashboard/integrations` (Den), `/o/:slug/dashboard/plugins` (Den)

---

## TL;DR

- A **connector** is an OAuth-backed transport that reads a filesystem tree from an external system (GitHub, Bitbucket) and hands it to a shared **ingester**.
- The ingester decomposes the tree into **Primitives** (skill, agent, command, MCP server, OpenCode plugin code).
- **Bundles** (what the product calls "plugins") are DB-level groupings of primitives — they are **virtual** as far as OpenCode is concerned. OpenCode never sees a `plugin.json`.
- **Installing a bundle into a workspace** means writing each member primitive to its **native `.opencode/` path** via the OpenWork server's existing per-workspace endpoints. The `reload-watcher` then propagates to running sessions.
- `.opencode/` is the **source of truth** on disk. Our remote DB is an **index** that bundles + surfaces primitives across the org. A future "local DB triggered via a skill" will invert the index relationship locally; the server schema is designed to accommodate that.

### Reader map

| Looking for… | Jump to |
|---|---|
| What does OpenCode actually load from disk? | [OpenCode interpretation](#opencode-interpretation--what-opencode-actually-sees) |
| End-to-end flow (create → index → denominate → install) | [Four-phase lifecycle](#four-phase-lifecycle) |
| Exact types to implement | [Typed schemas](#typed-schemas) |
| Every API endpoint | [API endpoints](#api-endpoints) |
| How each step actually runs over the wire | [Sequence flows](#sequence-flows) |
| How a user authors a plugin without a repo | [Authoring flow](#authoring-flow-creating-primitives--bundles-in-app) |
| How we close the loop back to the ecosystem | [Publish / export](#publish--export-sharing-authored-bundles) |
| From inside an agent / shell | [CLI surface](#cli-surface) |
| What's shipped when | [Rollout plan](#rollout-plan) |
| How we know it works | [Test strategy](#test-strategy) |
| What's still undecided | [Open questions](#open-questions) |

## Mental model

Three nouns, kept strictly distinct:

| Noun | What it is | Who creates it | Shape |
|---|---|---|---|
| **ConnectorType** | The adapter class itself (e.g., "github", "bitbucket", "npm", "local"). Code in our server. | Us — v1 is in-house. v2 could accept plugin-authored adapters. | Code |
| **Integration** | An org's authorized grant to one ConnectorType + their selected sources (e.g., "GitHub account `different-ai`, 3 repos"). Persisted, scoped to an org. | End user via OAuth flow. | DB row |
| **Bundle** ("plugin" in UI copy) | A curated collection of primitives (skills, agents, commands, MCPs, code hooks) that can be installed as a unit. | Either: imported from a connector source (e.g., `.claude-plugin/marketplace.json` in a repo), or authored directly in the app. | DB row + BundleMembers |

The UI already shipped on `/integrations` (PRs #1472, #1475) drives ConnectorType + Integration. The `/plugins` UI (PR #1472) will drive Bundle browsing/detail. **A new page is needed for workspace installation** (Phase 4 below).

## OpenCode interpretation — what OpenCode actually sees

OpenCode is the execution layer. It **only** reads a workspace directory containing `opencode.json{c}` and an optional `.opencode/`. Any product concept that OpenCode does not see on disk is invisible to the runtime.

### OpenCode vs Claude Code — compatibility table

| Primitive | Claude Code convention | OpenCode convention | Auto-portable? |
|---|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | **None** (no manifest file) | ❌ — OpenWork-only DB concept |
| Marketplace catalog | `.claude-plugin/marketplace.json` | **None** | ❌ — OpenWork-only DB concept |
| Skills | `.claude/skills/<name>/SKILL.md` (YAML + md) | `.opencode/skill[s]/<name>/SKILL.md` **and** `.claude/skills/**/SKILL.md` **and** `.agents/skills/**/SKILL.md` (all three scanned natively unless `OPENCODE_DISABLE_EXTERNAL_SKILLS` is set) | ✅ **drop-in** |
| Agents | `.claude/agents/<name>.md` | `.opencode/agent[s]/<name>.md` — file shape identical, path differs | ⚠️ re-home path, content unchanged |
| Commands | `.claude/commands/<name>.md` | `.opencode/command[s]/<name>.md` — file shape identical (same `$ARGUMENTS` templating), path differs | ⚠️ re-home path, content unchanged |
| MCP servers | `.mcp.json` (project root) | `opencode.json{c}` → `mcp{}` key | ⚠️ expand into JSONC |
| Hooks | `.claude/hooks/` + `hooks.json` (declarative events) | **Code-only**: JS/TS module in `.opencode/plugin[s]/` exporting a `Hooks` interface | ❌ Claude JSON hooks **cannot** be auto-ported |
| Plugins | Source-distributed bundle | `opencode.json` → `plugin[]` (npm spec) **or** `.opencode/plugin[s]/<name>.{ts,js}` (file URL, auto-installed via `bun`) | Different semantic — OpenCode plugins are code; Claude "plugins" are catalog entries |

### What this forces on our design

1. **"Plugin" in Claude terminology ≠ "Plugin" in OpenCode terminology.** Our internal name for the Claude concept is **Bundle**. The UI can still say "Plugins" for user familiarity, but the codebase must not conflate them.
2. **The ingester is also a rehoming step.** A Claude-style `.claude-plugin/*` tree becomes OpenCode-native paths at materialization time. This is where the `.claude/agents/ → .opencode/agents/` move happens.
3. **Skill compatibility is a freebie.** SKILL.md is portable; we parse it once and write it back unchanged on install.
4. **Hooks need a policy.** See [Hooks strategy](#hooks-strategy).

### Real examples we target

Skill (frontmatter + body, OpenCode reads both `.opencode/skills/` and `.claude/skills/`):

```markdown
---
name: skill-creator
description: Create new OpenCode skills with the standard scaffold.
---

Skill creator helps create other skills that are self-buildable.
```

Command (`.opencode/commands/release.md`):

```markdown
---
description: Run the OpenWork release flow
---

You are running the OpenWork release flow in this repo.
Arguments: `$ARGUMENTS`
```

Agent (`.opencode/agent/triage.md`):

```markdown
---
mode: primary
model: opencode/claude-haiku-4-5
tools:
  "*": false
  "github-triage": true
---

You are a triage agent responsible for triaging github issues.
```

MCP (inside `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "control-chrome": {
      "type": "local",
      "command": ["chrome-devtools-mcp"]
    }
  },
  "plugin": ["opencode-scheduler"]
}
```

## Four-phase lifecycle

Split the problem into four phases. Each phase has its own API surface, UI, and failure modes. The earlier phases can **assume** later ones exist; later phases **depend on** earlier ones having produced data.

### Phase 1 — Ingest (connectors)

> Assume: primitives already exist somewhere (a GitHub repo maintained by a human, or a `.claude-plugin/marketplace.json` tree, or an npm package). We are not authoring them here; we are **bringing them in**.

Actors: connector adapter + ingester.

Flow:

1. User on `/integrations` authorizes GitHub/Bitbucket (OAuth).
2. User selects repos; we create `PluginSource` rows.
3. Ingester fetches the filesystem for each source. Supported shapes:
   - `.claude-plugin/marketplace.json` → catalog of bundles in this repo
   - `.claude-plugin/plugin.json` → single bundle at repo root
   - `opencode.json{c}` + `.opencode/*` → native OpenCode workspace exported as a single "workspace bundle"
   - Bare `skills/<name>/SKILL.md` tree with no manifest → one inferred bundle of skills
4. Ingester walks the tree and upserts **Primitives** into the DB (Phase 2).
5. Ingester optionally upserts **Bundles** and **BundleMembers** (Phase 3) if a manifest was present. If not, a user can create bundles manually in Phase 3.

Failure modes: invalid YAML frontmatter, forbidden `../` paths, hooks written in Claude JSON (flagged, see Hooks strategy), missing required fields. All surface as non-fatal `SyncEvent`s on the source.

### Phase 2 — Primitive index (DB)

> Assume: Phase 1 has produced raw content. Phase 2 stores each primitive as a first-class row so it can be searched, bundled, mutated, and projected to a workspace.

Every primitive gets a row with the same envelope, differing only by `kind`:

```
Primitive
  id
  org_id
  kind                      # "skill" | "agent" | "command" | "mcp_server" | "plugin_code"
  name                      # e.g. "skill-creator"  (unique within (org_id, kind, origin))
  content                   # raw source: SKILL.md body, agent .md, command .md, TS code, or JSON for mcp
  content_hash              # sha256 for change detection
  metadata                  # parsed frontmatter or decoded JSON
  origin                    # tagged union — see below
  validation_status         # "ok" | "warn" | "error"
  validation_messages[]
  created_at
  updated_at
```

`origin` tagged union:

```
  | { type: "connector", plugin_source_id, path_in_repo, commit_sha }
  | { type: "authored",  author_org_membership_id }
  | { type: "local_mirror", workspace_id, local_revision }   # future: local-DB SoT
```

Primitives are **org-scoped**, not workspace-scoped. The same `Primitive` row can be installed into many workspaces.

### Phase 3 — Denomination (Bundle)

> Assume: Phase 2 has given us primitives. Phase 3 groups them into shippable units.

```
Bundle
  id
  org_id
  slug                       # "openwork-release-kit"
  name                       # "OpenWork Release Kit"
  description
  version                    # "2.3.1"
  icon                       # emoji or URL
  category                   # display-only
  origin                     # same tagged union as Primitive
  published_at

BundleMember
  bundle_id
  primitive_id
  ordinal                    # for list display
```

Bundle creation paths:

1. **Imported**: a `.claude-plugin/marketplace.json` or `plugin.json` produces one Bundle row per plugin in the catalog, with BundleMembers derived from the plugin's skill/agent/command/mcp/hook entries.
2. **Authored in the app**: user picks existing Primitives and drags them into a new Bundle. No connector required.
3. **Generated by another tool** (future): an agent creates a Bundle representing its own capabilities.

The word "Bundle" lives in the schema; the UI can continue to say "Plugin" for user familiarity.

### Phase 4 — Install (materialize into a workspace)

> Assume: Phases 1–3 have produced a Bundle. Phase 4 projects its primitives onto a specific OpenCode workspace so the OpenCode runtime loads them.

```
WorkspaceInstallation
  id
  org_id
  bundle_id
  workspace_id               # the OpenWork workspace (worker + path)
  scope                      # "org" | "user" | "workspace" — affects conflict resolution
  status                     # "pending" | "materializing" | "applied" | "error" | "uninstalled"
  bundle_version_at_install
  applied_primitive_digests  # [{ primitive_id, target_path, content_hash }]
  installed_at
  updated_at
  error                      # nullable; populated on failure
```

Materialization steps (all executed server-side against the OpenWork server API — not direct FS access):

| Primitive kind | Target path in workspace | Mutation endpoint |
|---|---|---|
| `skill` | `.opencode/skills/<name>/SKILL.md` | `POST /workspace/:id/skills` |
| `agent` | `.opencode/agents/<name>.md` | `POST /workspace/:id/files/content` *(no dedicated agents endpoint today — flagged in Open Questions)* |
| `command` | `.opencode/commands/<name>.md` | `POST /workspace/:id/commands` |
| `mcp_server` | merged into `opencode.jsonc` → `mcp[name]` | `POST /workspace/:id/mcp` |
| `plugin_code` | `.opencode/plugins/<name>.ts` **and/or** `opencode.jsonc` → `plugin[]` | `POST /workspace/:id/plugins` |

The `reload-watcher` on the server picks up each file write and emits `ReloadEvent`s keyed by `workspaceId`. OpenCode-running sessions pick up skills/commands/agents hot; plugin code and MCP changes require a new session (reload-watcher already handles this via `openwork.json` → `reload.auto`).

**Uninstall**: the server looks up `applied_primitive_digests` and deletes each target. Content-hash check prevents stomping on user-edited files — if the current on-disk hash differs, the file is left alone and a `drift` warning is stored on the installation row.

**Conflict resolution** (two bundles declare the same skill name):

- Scope precedence: `workspace > user > org`. A lower-scope install overwrites a higher-scope one and restores on uninstall.
- Same-scope collision: installation fails with a clear error; the user picks which Bundle owns the name.

## Data model (updated)

```
Organization
  └─ Integration                     1 row per (org × connector_type × provider_account)
     ├─ connector_type               "github" | "bitbucket" | …
     ├─ account                      { id, name, kind: "user" | "org" }
     ├─ credentials_encrypted
     └─ PluginSource[]               1 row per attached repo / subdir / ref
        ├─ locator                   { repo, ref?, path?, sha? }
        ├─ last_sync_at / _status
        └─ discovered: Primitive[], Bundle[]

Primitive                            the atoms — org-scoped
  kind, name, content, hash, metadata, origin, validation_status

Bundle                               the grouping — org-scoped (Phase 3 output)
  ├─ BundleMember[]  →  Primitive

WorkspaceInstallation                Phase 4: projection onto a workspace
  ├─ bundle_id
  ├─ workspace_id
  └─ applied_primitive_digests[]
```

**Why this shape:**

- Primitives and Bundles are cleanly separated — a primitive can live outside a bundle (useful for org-authored skills that aren't shipped), and the same primitive can belong to many bundles.
- The `origin` tagged union lets the same table model both connector-imported and app-authored primitives with no special cases downstream.
- `WorkspaceInstallation.applied_primitive_digests` gives clean uninstall + drift detection.
- The future "local DB triggered via a skill" (§ [Local-DB future](#local-db-future)) slots in by adding `{ type: "local_mirror", … }` as a third `origin` variant without touching the rest of the schema.

## Typed schemas

TypeScript-style definitions for the core entities. These are the canonical shapes shared across the DB ORM, the API layer, and (eventually) the Den web SDK. Field names are camelCase in the API and snake_case in the DB per existing Den conventions — listed here in camelCase.

### Shared primitives

```ts
type Iso8601 = string;                          // "2026-04-17T11:22:33Z"
type Sha256  = string;                          // lowercased hex
type UUID    = string;                          // v7
type KebabCase = string;                        // ^[a-z][a-z0-9-]*$

type PrimitiveKind =
  | "skill"
  | "agent"
  | "command"
  | "mcp_server"
  | "plugin_code"
  | "hook";                                     // claude-json hooks; warn-only in v1

type ConnectorType = "github" | "bitbucket";    // extensible

type InstallScope = "org" | "user" | "workspace";

type ValidationStatus = "ok" | "warn" | "error";
type ValidationMessage = { code: string; message: string; path?: string };

type Origin =
  | { type: "connector"; pluginSourceId: UUID; pathInRepo: string; commitSha: string }
  | { type: "authored";  authorOrgMembershipId: UUID }
  | { type: "local_mirror"; workspaceId: UUID; localRevision: number };       // future
```

### Integration + PluginSource

```ts
type Integration = {
  id: UUID;
  orgId: UUID;
  connectorType: ConnectorType;
  account: { id: string; name: string; kind: "user" | "org"; avatarUrl?: string };
  credentialsEncrypted: string;                 // opaque; decrypted server-side only
  tokenExpiresAt: Iso8601 | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

type PluginSourceLocator =
  | { kind: "repo";     repo: string; ref?: string; sha?: string }            // "owner/repo"
  | { kind: "subdir";   repo: string; path: string; ref?: string; sha?: string }
  | { kind: "npm";      pkg:  string; version?: string; registry?: string };  // future

type SyncStatus = "pending" | "ok" | "error";

type PluginSource = {
  id: UUID;
  orgId: UUID;
  integrationId: UUID;
  locator: PluginSourceLocator;
  webhookId: string | null;                     // provider-side webhook identifier
  lastSyncAt: Iso8601 | null;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};
```

### Primitive (kind-discriminated)

```ts
type Primitive = {
  id: UUID;
  orgId: UUID;
  kind: PrimitiveKind;
  name: KebabCase;                              // unique within (orgId, kind, origin-key)
  content: string;                              // raw md/ts/json
  contentHash: Sha256;
  metadata: PrimitiveMetadata;                  // discriminated on kind
  origin: Origin;
  validationStatus: ValidationStatus;
  validationMessages: ValidationMessage[];
  deletedAt: Iso8601 | null;                    // soft-delete so re-ingest can restore
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

type PrimitiveMetadata =
  | { kind: "skill";       description: string; license?: string; tags?: string[] }
  | { kind: "agent";       description?: string; model?: string; mode?: "primary" | "subagent" | "all"; tools?: Record<string, boolean>; color?: string }
  | { kind: "command";     description?: string; agent?: string; model?: string; argumentsHint?: string[] }
  | { kind: "mcp_server";  transport: "local" | "remote"; command?: string[]; url?: string; env?: Record<string, string> }
  | { kind: "plugin_code"; language: "ts" | "js"; entryFile: string }
  | { kind: "hook";        event: string; matcher?: string; command: string };           // claude-json shape
```

### Bundle + BundleMember

```ts
type Bundle = {
  id: UUID;
  orgId: UUID;
  slug: KebabCase;                              // unique within org
  name: string;
  description: string;
  version: string;                              // semver
  icon?: string;                                // emoji or https URL
  category?: string;
  origin: Origin;
  publishedAt: Iso8601 | null;
  deletedAt: Iso8601 | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

type BundleMember = {
  bundleId: UUID;
  primitiveId: UUID;
  ordinal: number;                              // display order
};
```

### WorkspaceInstallation

```ts
type InstallationStatus =
  | "pending" | "materializing" | "applied" | "error" | "uninstalled";

type AppliedPrimitiveDigest = {
  primitiveId: UUID;
  kind: PrimitiveKind;
  targetPath: string;                           // e.g. ".opencode/skills/release-prep/SKILL.md"
  contentHashAtWrite: Sha256;                   // for drift detection on read-back
};

type WorkspaceInstallation = {
  id: UUID;
  orgId: UUID;
  bundleId: UUID;
  workspaceId: UUID;
  scope: InstallScope;
  status: InstallationStatus;
  bundleVersionAtInstall: string;
  appliedPrimitiveDigests: AppliedPrimitiveDigest[];
  installedAt: Iso8601;
  updatedAt: Iso8601;
  error: { code: string; message: string } | null;
};
```

### API request/response shapes (examples)

```ts
// POST /v1/orgs/:orgId/integrations/authorize
type AuthorizeRequest  = { connectorType: ConnectorType; redirectAfter?: string };
type AuthorizeResponse = { redirectUrl: string; state: string };

// POST /v1/orgs/:orgId/integrations/:id/plugin-sources
type AttachSourcesRequest  = { sources: PluginSourceLocator[] };
type AttachSourcesResponse = { sources: PluginSource[] };

// POST /v1/orgs/:orgId/bundles
type CreateBundleRequest = {
  slug: KebabCase;
  name: string;
  description: string;
  version: string;
  icon?: string;
  category?: string;
  memberPrimitiveIds: UUID[];                   // primitives must already exist in the org
};
type CreateBundleResponse = Bundle & { members: BundleMember[] };

// POST /v1/workspaces/:workspaceId/installations
type CreateInstallationRequest  = { bundleId: UUID; scope: InstallScope };
type CreateInstallationResponse = WorkspaceInstallation;

// GET /v1/workspaces/:workspaceId/installations/:id/status
type InstallationStatusResponse = {
  status: InstallationStatus;
  progress: Array<{
    primitiveId: UUID;
    name: string;
    targetPath: string;
    state: "pending" | "writing" | "ok" | "error";
    error?: string;
  }>;
};
```

## Source-of-truth policy

`.opencode/` on a worker's disk is the **canonical** state of what OpenCode actually loads. The remote DB is an **index** that:

1. Knows which primitives exist across the org.
2. Knows which bundles compose which primitives.
3. Knows which workspaces have which bundles installed.
4. Records `applied_primitive_digests` so it can diff against disk and detect drift.

When disk and DB disagree, disk wins for OpenCode loading. The DB updates its `validation_status` and drift markers but does not force a rewrite — user edits on disk are respected.

### Local-DB future

Long-term direction (informational — not in v1 scope):

- A tiny **OpenWork skill** running inside the user's workspace maintains a **local SQLite** DB that mirrors the subset of the remote DB relevant to that workspace (primitives + installed bundles).
- This local DB becomes the operational source of truth for the workspace; the remote DB becomes a sync target and cross-workspace index.
- Connectors, installers, and authoring tools all read/write the local DB; a background sync skill reconciles with the remote.
- Benefits: works offline, no network trip for "what's installed in this workspace", enables per-workspace forks of a bundle without polluting org-wide state.
- Schema preparation: the `origin.local_mirror` variant on `Primitive` is already designed for this.

For v1 we ship the remote DB only. The API contracts below do not change when the local DB lands — the local DB speaks the same schema and exposes the same endpoints over a UNIX socket or the existing server instance.

## API endpoints

Grouped by concern. All org-scoped routes live under `/v1/orgs/:orgId/...` consistent with the existing Den API (`/v1/orgs/:orgId/skills`, `/v1/orgs/:orgId/skill-hubs`).

### 1. Connector-type registry (read-only catalog)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/connector-types` | List adapters the server supports, with display metadata, supported auth flow (`oauth2` / `token` / `local`), and required scopes. Powers the list of cards on `/integrations`. |
| `GET` | `/v1/connector-types/:type` | Detail for one adapter. |

### 2. Integrations (the OAuth dance)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/integrations` | List this org's integrations, including account + repo counts. Replaces the mock `useIntegrations()`. |
| `POST` | `/v1/orgs/:orgId/integrations/authorize` | Body: `{ connectorType }`. Returns `{ redirectUrl, state }`. Client navigates to the provider. |
| `GET` | `/v1/oauth/:type/callback` | Provider hits this with `?code&state`. Server exchanges for tokens, resolves the account, creates the Integration row, redirects to the app (`/o/:slug/dashboard/integrations?success=...`). |
| `GET` | `/v1/orgs/:orgId/integrations/:id` | Detail for one integration. |
| `POST` | `/v1/orgs/:orgId/integrations/:id/refresh-token` | Explicit refresh (mostly internal). |
| `DELETE` | `/v1/orgs/:orgId/integrations/:id` | Disconnect; revoke at provider if possible; cascade-delete `PluginSource`s and their derived Primitives/Bundles. |

### 3. Account + repo enumeration (populates the wizard steps 2 & 3)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/integrations/:id/accounts` | Proxy call to the provider for user + orgs/workspaces the grant can see. |
| `GET` | `/v1/orgs/:orgId/integrations/:id/accounts/:accountId/repos?q=&cursor=` | Paginated repo list, optionally filtered. Each repo flagged `hasPluginManifest: boolean` (server peeks for `.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json`). |

### 4. Plugin sources (attaching a repo to the Integration)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/plugin-sources` | All sources attached across integrations. |
| `POST` | `/v1/orgs/:orgId/integrations/:id/plugin-sources` | Body: `[{ repo, ref?, path?, sha? }, …]`. Server registers webhook, triggers initial sync. |
| `DELETE` | `/v1/orgs/:orgId/plugin-sources/:sourceId` | Detach; cascade-delete the Primitives/Bundles it produced. |
| `POST` | `/v1/orgs/:orgId/plugin-sources/:sourceId/sync` | Force a refresh. Re-reads the tree, upserts Primitives + Bundles. |
| `GET` | `/v1/orgs/:orgId/plugin-sources/:sourceId/events` | Sync history (SSE or paginated log). |

### 5. Primitives (Phase 2 — org-scoped atoms)

Each primitive kind gets a resource. Shared shape, different payload. Internally backed by one `primitives` table with a `kind` discriminator.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/primitives?kind=&originType=&q=&cursor=` | Combined index across all kinds. Powers the "All Skills / All Hooks / All MCPs" tabs on `/plugins`. |
| `GET` | `/v1/orgs/:orgId/primitives/:id` | Detail for any primitive kind. |
| `POST` | `/v1/orgs/:orgId/primitives` | Author a new primitive in the app. Body: `{ kind, name, content, metadata? }`. `origin` is set server-side to `{ type: "authored", author_org_membership_id }`. |
| `PATCH` | `/v1/orgs/:orgId/primitives/:id` | Edit content/metadata of an authored primitive. Connector-sourced primitives are read-only (return 409). |
| `DELETE` | `/v1/orgs/:orgId/primitives/:id` | Delete an authored primitive. Connector-sourced primitives get hidden (`deleted_at` set) so re-ingest can restore them. |

Convenience kind-scoped views (optional; all read from the same table):

- `GET /v1/orgs/:orgId/skills`
- `GET /v1/orgs/:orgId/agents`
- `GET /v1/orgs/:orgId/commands`
- `GET /v1/orgs/:orgId/mcp-servers`
- `GET /v1/orgs/:orgId/plugin-code` *(OpenCode code plugins, distinct from our Bundle concept)*

The existing `GET /v1/orgs/:orgId/skills` endpoint in Den API stays and grows `originType` / `pluginSourceId` / `bundleId` filter params.

### 6. Bundles (Phase 3 — denomination)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/bundles?q=&category=&originType=` | All bundles in the org. Replaces mock `usePlugins()`. |
| `GET` | `/v1/orgs/:orgId/bundles/:id` | Bundle detail with embedded BundleMembers → resolved Primitives. Replaces mock `usePlugin(id)`. |
| `POST` | `/v1/orgs/:orgId/bundles` | Author a new bundle. Body: `{ slug, name, description, version, icon?, category?, memberPrimitiveIds: [...] }`. |
| `PATCH` | `/v1/orgs/:orgId/bundles/:id` | Edit authored bundle metadata. Imported bundles are read-only. |
| `DELETE` | `/v1/orgs/:orgId/bundles/:id` | Delete an authored bundle. Imported bundles hidden (re-ingest restores). |
| `POST` | `/v1/orgs/:orgId/bundles/:id/members` | Body: `{ primitiveId, ordinal? }`. Add a primitive to the bundle. |
| `DELETE` | `/v1/orgs/:orgId/bundles/:id/members/:primitiveId` | Remove a primitive from the bundle. |
| `POST` | `/v1/orgs/:orgId/bundles/:id/members/reorder` | Body: `[primitiveId, …]`. Reorders the bundle's member list. |

### 7. Workspace installations (Phase 4 — projection)

Workspace scope lives under `/v1/workspaces/:workspaceId/…` — mirrors the existing OpenWork server shape (`/workspace/:id/skills`, `/workspace/:id/commands`, etc.). The installation endpoints below are **orchestrators** that internally fan out to those existing workspace-level endpoints. No new filesystem primitives required.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/workspaces/:workspaceId/installations` | What bundles are installed in this workspace, with status + drift info. |
| `GET` | `/v1/workspaces/:workspaceId/installations/:id` | Detail: list of applied primitives with their target paths and content hashes. |
| `POST` | `/v1/workspaces/:workspaceId/installations` | Body: `{ bundleId, scope }`. Creates the row, begins materializing. Returns `{ id, status: "materializing" }`. |
| `GET` | `/v1/workspaces/:workspaceId/installations/:id/status` | Poll endpoint (or SSE). Reports per-primitive progress: `pending` → `writing` → `ok`/`error`. |
| `POST` | `/v1/workspaces/:workspaceId/installations/:id/reapply` | Re-run materialization against the current Bundle version. Useful after drift. |
| `DELETE` | `/v1/workspaces/:workspaceId/installations/:id` | Uninstall — reverses writes using `applied_primitive_digests`. Files that no longer match their recorded digest are left alone (drift safe) and reported. |

Materialization engine (server-side only — not a public endpoint) maps each primitive kind to the existing per-workspace endpoint. See [materialization table](#four-phase-lifecycle) above.

### 8. Webhooks (provider → us)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/webhooks/github` | Signed by `X-Hub-Signature-256`. On `push` to a tracked ref, reindex affected `PluginSource`s. Triggers re-materialization for every WorkspaceInstallation whose Bundle contains a changed Primitive. |
| `POST` | `/v1/webhooks/bitbucket` | Equivalent. |

### 9. Admin / health (optional v1.1)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/integrations/:id/diagnostics` | Token expiry, last webhook time, error stream — powers a "something is wrong" banner. |
| `GET` | `/v1/workspaces/:workspaceId/installations/:id/drift` | Compares `applied_primitive_digests` to current on-disk hashes via the existing `/workspace/:id/skills` etc. Returns per-primitive drift status. |

## Sequence flows

### A. Connect a source (Phase 1)

```
 User            Den web             Den API             Provider           OpenWork server
  │                 │                  │                    │                    │
  │─ click Connect ─▶                  │                    │                    │
  │                 │─ POST /integrations/authorize ───────▶│                    │
  │                 │◀──  { redirectUrl, state }  ──────────│                    │
  │◀─ window.location = redirectUrl ───│                    │                    │
  │────────────── OAuth consent ──────────────────▶          │                    │
  │                                     ◀─ 302 w/ code ─────│                    │
  │─ GET /v1/oauth/:type/callback?code&state ──▶│           │                    │
  │                                     │  exchange code    │                    │
  │                                     │───── POST token ─▶│                    │
  │                                     │◀─ access_token ───│                    │
  │                                     │  upsert Integration                    │
  │◀─ 302 /integrations?success&id=…────│                    │                    │
  │                 │                  │                    │                    │
  │─ select repos ──▶                   │                    │                    │
  │                 │─ POST /integrations/:id/plugin-sources ▶│                  │
  │                 │  server: attach sources, register webhook                  │
  │                 │         enqueue initial sync job       │                    │
  │                 │◀── { sources[], jobId }────────────────│                    │
  │                 │                  │                    │                    │
  │                 │         (job runs)                     │                    │
  │                 │                  │ fetchPluginFS ─────▶│                    │
  │                 │                  │◀── FileTree ────────│                    │
  │                 │                  │ ingest → upsert Primitives + Bundles     │
```

### B. Webhook-driven re-sync

```
 Provider           Den API                                    DB
    │                  │                                        │
    │─ POST /v1/webhooks/github (push event) ────▶              │
    │                  │ verify HMAC                            │
    │                  │ find PluginSources w/ matching ref     │
    │                  │ for each: enqueue sync job             │
    │                  │           ├─ fetchPluginFS             │
    │                  │           ├─ ingest → diff             │
    │                  │           ├─ upsert changed Primitives │
    │                  │           └─ bump Bundle version if plugin.json version changed
    │                  │ fan out to WorkspaceInstallation(bundleId)
    │                  │   for each installation:               │
    │                  │     mark "update available" (not auto-apply)
```

### C. Install a bundle into a workspace (Phase 4)

```
 User            Den web           Den API                         OpenWork server                           Disk
  │                 │                │                                 │                                      │
  │─ click Install ▶│                │                                 │                                      │
  │                 │─ POST /workspaces/:wid/installations ───────────▶│                                      │
  │                 │  body: { bundleId, scope }                       │                                      │
  │                 │                │ create WorkspaceInstallation (status=pending)                          │
  │                 │                │ begin materialize job           │                                      │
  │                 │◀─ { installationId, status: "materializing" } ───│                                      │
  │                 │                │                                 │                                      │
  │                 │                │ for each BundleMember:          │                                      │
  │                 │                │   switch (primitive.kind):      │                                      │
  │                 │                │     skill   → POST /workspace/:wid/skills ─────────▶                   │
  │                 │                │                                 │ write .opencode/skills/<name>/SKILL.md│
  │                 │                │     command → POST /workspace/:wid/commands ────────▶                  │
  │                 │                │     mcp     → POST /workspace/:wid/mcp ─────────────▶                  │
  │                 │                │     plugin_code → POST /workspace/:wid/plugins ─────▶                  │
  │                 │                │     agent   → POST /workspace/:wid/files/content ───▶                  │
  │                 │                │   record AppliedPrimitiveDigest (targetPath, contentHashAtWrite)       │
  │                 │                │                                 │                                      │
  │                 │                │ reload-watcher emits ReloadEvents per affected subdir                  │
  │                 │                │ WorkspaceInstallation.status = "applied"                               │
  │                 │◀─ SSE/poll: status="applied", progress[] ────────│                                      │
  │                 │                │                                 │                                      │
  │                 │  OpenCode session:                                                                      │
  │                 │    auto-reload if openwork.json.reload.auto, else toast "reload available"              │
```

### D. Uninstall (drift-safe)

```
 Den API                                                              Disk
    │                                                                   │
    │ load WorkspaceInstallation.appliedPrimitiveDigests                 │
    │ for each digest:                                                   │
    │   GET current file via /workspace/:wid/{skills|commands|…} ──────▶ │
    │                                                            ◀───── │
    │   if (currentHash === digest.contentHashAtWrite):                  │
    │     DELETE /workspace/:wid/{…}/:name                               │
    │   else:                                                            │
    │     leave file; record drift.skipped[primitiveId]                  │
    │ status = "uninstalled"                                             │
    │ return { removed: [...], skipped: [...] }                          │
```

## How each connector is structured (GitHub + Bitbucket)

Both implement the same internal interface — only the provider-specific guts differ. Pseudocode:

```ts
interface Connector {
  type: "github" | "bitbucket";
  displayName: string;
  scopes: string[];

  // OAuth
  buildAuthorizeUrl({ orgId, state, redirectUri }): string;
  exchangeCode({ code }): { accessToken, refreshToken, expiresAt, account };
  refreshToken({ refreshToken }): { accessToken, refreshToken, expiresAt };
  revoke({ accessToken }): void;

  // Enumeration
  listAccounts({ credentials }): Account[];
  listRepos({ credentials, accountId, cursor? }): Page<Repo>;
  peekManifest({ credentials, locator }): "plugin" | "marketplace" | "none";

  // Ingestion — the heart of it
  fetchPluginFS({ credentials, locator }): FileTree;

  // Change detection
  registerWebhook({ credentials, locator, secret }): webhookId;
  unregisterWebhook({ credentials, locator, webhookId }): void;
  verifyWebhook(req): { ok: boolean; event?: RepoPushEvent };
}
```

A separate **ingester** (provider-agnostic) takes `FileTree`, detects the shape, produces `Primitive` upserts and (optionally) `Bundle`+`BundleMember` upserts:

```
ingest(fileTree, pluginSourceId):
  shape = detectShape(fileTree)
    # possible shapes:
    #   "claude-marketplace"   (.claude-plugin/marketplace.json)
    #   "claude-single"        (.claude-plugin/plugin.json at root)
    #   "opencode-workspace"   (opencode.json{c} + .opencode/)
    #   "bare-skills"          (skills/*/SKILL.md with no manifest)

  for each plugin-root in shape.pluginRoots:
    # 1. Parse primitives (always)
    walk skills/*/SKILL.md   → upsert Primitive(kind=skill, content=<md>,   metadata=<frontmatter>)
    walk agents/*.md         → upsert Primitive(kind=agent, content=<md>,   metadata=<frontmatter>)
    walk commands/*.md       → upsert Primitive(kind=command, content=<md>, metadata=<frontmatter>)
    parse .mcp.json OR       → upsert Primitive(kind=mcp_server, content=<json>, metadata=<name+config>)
          opencode.json.mcp  → upsert Primitive(kind=mcp_server, content=<json>, metadata=<name+config>)
    walk .opencode/plugins/*.{ts,js} → upsert Primitive(kind=plugin_code, content=<src>)
    parse hooks/hooks.json   → flag as Primitive(kind=hook, validation_status=warn, reason="claude-json-hooks")
                               # see "Hooks strategy" — not directly materializable on OpenCode

    # All primitives get origin = { type: "connector", plugin_source_id, path_in_repo, commit_sha }
    # content_hash = sha256(content)

    # 2. Parse bundle metadata (manifest-dependent)
    if shape == "claude-marketplace" or "claude-single":
      parse .claude-plugin/plugin.json  → upsert Bundle(name, description, version, …)
      link parsed primitives as BundleMembers
    if shape == "opencode-workspace":
      synthesize Bundle from opencode.json name/package metadata
      link all parsed primitives as members
    if shape == "bare-skills":
      synthesize Bundle(name = repo name, description = readme excerpt)
      link all skill primitives as members
```

This means the GitHub and Bitbucket connectors share ~80% of their effort as the ingester — each connector is just "auth + fetch file tree + detect changes". Adding GitLab / npm / local later is a ~200 LOC adapter, no new parsing logic.

### GitHub specifics

- **OAuth app** credentials server-side. Scopes `repo`, `read:org`.
- `buildAuthorizeUrl` → `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=…&scope=…&state=…`
- `exchangeCode` → `POST https://github.com/login/oauth/access_token`
- `listAccounts` → `GET /user` + `GET /user/orgs`
- `listRepos(accountId)` → `GET /orgs/:org/repos` or `GET /user/repos`
- `peekManifest` → `GET /repos/:owner/:repo/contents/.claude-plugin/marketplace.json` (404-tolerant)
- `fetchPluginFS` → tarball download (`GET /repos/:owner/:repo/tarball/:ref`) or git tree API for surgical reads
- `registerWebhook` → `POST /repos/:owner/:repo/hooks` filtered to `push` events
- `verifyWebhook` → HMAC-SHA256 against `X-Hub-Signature-256` using the per-source secret

### Bitbucket specifics

- **OAuth consumer** credentials server-side. Scopes `repository`, `account`.
- `buildAuthorizeUrl` → `https://bitbucket.org/site/oauth2/authorize?client_id=…&response_type=code&state=…`
- `exchangeCode` → `POST https://bitbucket.org/site/oauth2/access_token`
- `listAccounts` → `GET /2.0/user` + `GET /2.0/workspaces`
- `listRepos(workspace)` → `GET /2.0/repositories/:workspace`
- `peekManifest` → `GET /2.0/repositories/:workspace/:repo/src/:ref/.claude-plugin/marketplace.json`
- `fetchPluginFS` → recursive `/src/:ref/` walk or `/downloads/` tarball
- `registerWebhook` → `POST /2.0/repositories/:workspace/:repo/hooks`
- `verifyWebhook` → HMAC against `X-Hub-Signature` using the webhook UUID secret

## OAuth flow mapped to endpoints

What the UI currently simulates in `IntegrationConnectDialog` maps to real calls like this:

| Dialog step | Mock behavior now | Real behavior |
|---|---|---|
| 1. Authorize | Click advances state | `POST /integrations/authorize` → navigate to `redirectUrl` → provider redirects to `/v1/oauth/:type/callback` → Den redirects back to `/integrations?success&integrationId=…` |
| 2. Select account | `useIntegrationAccounts(provider)` from mock | `GET /integrations/:id/accounts` |
| 3. Select repos | `useIntegrationRepos(provider, accountId)` from mock | `GET /integrations/:id/accounts/:accountId/repos?q=…` |
| 4. Connecting | `useConnectIntegration().mutateAsync` — local mock | `POST /integrations/:id/plugin-sources` body: the selected repos — server queues initial sync |
| 5. Connected | Show success | Poll `GET /plugin-sources/:id/status` or SSE until `last_sync_status === "ok"` |

## Security

- Credentials encrypted at rest (AES-GCM with a KMS-rotated key, per-org data key).
- OAuth `state` stored server-side for 10 min, single-use, bound to `orgId + userId`.
- Webhook secrets per `PluginSource`, not per integration — so revoking one source doesn't nuke the rest.
- `peekManifest` and `fetchPluginFS` must tolerate 404 / 403 / rate-limit and never throw into user flow — return typed results.
- Per-installation revocation should call provider revoke endpoints (`DELETE /applications/:client_id/grant` for GitHub, Bitbucket equivalent).
- Audit log row for every integration-level action (connect, disconnect, token refresh, source add, source remove, webhook verify failure).
- **Strict manifest validation** before ingestion — reject plugins that reference files outside their plugin root (`../shared-utils`), same rule Claude Code enforces.

## Hooks strategy

Claude Code's `hooks.json` is declarative (events + shell commands). OpenCode's hooks are **code** (JS/TS exporting a `Hooks` interface from a plugin). These are not mechanically equivalent. Three options:

| Option | What it does | Cost | Verdict |
|---|---|---|---|
| A. Refuse import | At ingest, detect Claude-style `hooks/hooks.json`. Store the raw JSON on the Bundle but mark those hook primitives as `validation_status: "warn"` with a message: "Claude-style JSON hooks require an OpenCode plugin wrapper. [Docs]". Nothing materializes. | Zero | **v1 default** |
| B. Auto-wrap | On install, generate a `.opencode/plugins/<bundle-slug>-hooks.ts` that reads the JSON manifest and maps each Claude event to the equivalent OpenCode hook, spawning the declared shell command. | Medium — need a careful event mapping table and a stable wrapper runtime. | v1.1 |
| C. Ship a universal runner | Publish one npm package `@openwork/claude-hooks-runtime` that reads JSON hooks from a well-known path (`.opencode/openwork/hooks/*.json`) and registers them once. Installing any Bundle with JSON hooks just drops files in that path. | High upfront (one-time infrastructure) but zero per-Bundle cost thereafter. | v2 — best long-term |

Recommendation: **A → C**. Ship A now so imports don't fail catastrophically, schedule C as a dedicated workstream. Skip B (per-Bundle codegen is a maintenance liability).

Event mapping table we'd need for B/C (Claude → OpenCode):

| Claude event | OpenCode equivalent | Notes |
|---|---|---|
| `PreToolUse` | `tool.execute.before` | matcher on tool name |
| `PostToolUse` | `tool.execute.after` | |
| `SessionStart` | `event` with `session.start` | via generic event hook |
| `SessionEnd` | `event` with `session.end` | |
| `UserPromptSubmit` | `chat.message` or `experimental.chat.messages.transform` | |
| `Notification` | no direct equivalent | punt |
| `Stop` | `experimental.session.compacting` (close) | approximate |

## Authoring flow (creating primitives + bundles in-app)

The reverse of ingest. A user authors Primitives + Bundles directly without a connector, e.g. to capture an ad-hoc skill they just wrote in chat.

### A.1 Author a primitive

1. User clicks **"Create skill"** (or agent/command/MCP) from `/plugins` → `All Skills` tab.
2. A composer drawer opens with the right form per `kind`:
   - `skill` → YAML frontmatter (`name`, `description`) + body editor.
   - `agent` → frontmatter (`mode`, `model`, `tools` etc.) + system-prompt body.
   - `command` → frontmatter (`description`, `agent?`, `model?`) + template with `$ARGUMENTS`.
   - `mcp_server` → form (transport, command/url, env).
3. `POST /v1/orgs/:orgId/primitives` creates the row with `origin = { type: "authored", authorOrgMembershipId }`.
4. `validation_status` is computed synchronously (frontmatter schema, name kebab-case, reserved names, forbidden paths).

### A.2 Compose a bundle

1. `/plugins` → **"Create plugin"** button opens the bundle composer.
2. User picks `name`, `description`, `version`, `icon`, `category`, and searches existing Primitives to add as `BundleMember`s (drag or click).
3. `POST /v1/orgs/:orgId/bundles` with `{ slug, name, …, memberPrimitiveIds }`.
4. The server enforces that every referenced primitive belongs to the same org.

### A.3 Edit / delete

- Authored primitives + bundles are mutable via `PATCH` and `DELETE`.
- Connector-sourced primitives/bundles are read-only; `PATCH` returns `409 conflict_readonly_connector_source` with a hint to fork.
- **Fork**: `POST /v1/orgs/:orgId/primitives/:id/fork` (and similar for bundles) creates an authored copy the user can edit.

## Publish / export (sharing authored bundles)

Closes the loop with the ecosystem: an authored Bundle can be pushed back to a Git repo as a Claude-compatible marketplace tree so other OpenWork (or Claude Code) users can ingest it.

### Flow

1. User on a Bundle detail page clicks **"Publish to repo"**.
2. Picks a target: a connected Integration + repo + branch.
3. `POST /v1/orgs/:orgId/bundles/:id/publish` with `{ targetRepo, targetRef, commitMessage }`.
4. Server materializes the Bundle into a `.claude-plugin/` tree in a scratch directory:
   - `.claude-plugin/plugin.json` ← Bundle metadata
   - `skills/<name>/SKILL.md` ← each `skill` Primitive
   - `agents/<name>.md` ← each `agent` Primitive
   - `commands/<name>.md` ← each `command` Primitive
   - `.mcp.json` ← merged `mcp_server` Primitives
   - OpenCode plugin code Primitives → warn (Claude target doesn't support native TS plugins)
5. Server commits + pushes via the Integration's credentials. Returns the commit SHA + a link.

### Multi-bundle publishing

Publishing multiple Bundles to the same repo synthesises a `.claude-plugin/marketplace.json` catalog listing each as a plugin entry under `plugins/<slug>/`.

### Round-trip guarantee

Ingesting an exported tree back into OpenWork MUST produce semantically-identical Primitives (same `contentHash` per primitive, same Bundle membership). This is a tested invariant — see [Test strategy](#test-strategy).

## CLI surface

For agents running inside an OpenCode session to manage the catalog without leaving the shell. Mirrors Claude Code's `claude plugin …` commands.

```
openwork connector list
openwork connector add github --repo different-ai/openwork-plugins [--ref main]
openwork connector remove <source-id>
openwork connector sync <source-id>

openwork bundle list [--installed]
openwork bundle show <bundle-slug>
openwork bundle install <bundle-slug> [--scope workspace|user|org]
openwork bundle uninstall <bundle-slug>
openwork bundle publish <bundle-slug> --to github:owner/repo [--ref main]

openwork primitive list [--kind=skill|agent|…]
openwork primitive show <name> --kind=<kind>
openwork primitive create --kind=skill --file=./my-skill.md
```

All commands hit the same API endpoints as the web UI — the CLI is a thin shell over `requestJson`. Output formats: `--json` for scripting, default human-friendly tables.

An **OpenWork skill** wraps the CLI and surfaces it to agents:

```yaml
---
name: openwork-plugin-manager
description: |
  Install, uninstall, and discover OpenWork plugins (bundles).

  Triggers when user mentions:
  - "install plugin"
  - "what plugins are available"
  - "publish this as a plugin"
---
```

This makes the full lifecycle reachable from inside any OpenCode conversation — living system behavior.

## Observability + audit events

Every state-changing operation emits an `AuditEvent` row with structured fields. Used for debugging, billing-relevant rate limits, and compliance.

```ts
type AuditEvent = {
  id: UUID;
  orgId: UUID;
  actor: { kind: "user" | "system" | "webhook"; id?: string };
  event: AuditEventType;
  subject: { kind: string; id: string };        // e.g. { kind: "integration", id: "…" }
  metadata: Record<string, unknown>;             // event-specific
  createdAt: Iso8601;
  requestId: string;                             // for correlating with logs
};

type AuditEventType =
  // Integrations
  | "integration.connected"
  | "integration.disconnected"
  | "integration.token_refreshed"
  | "integration.webhook_verify_failed"
  // Sources
  | "plugin_source.attached"
  | "plugin_source.detached"
  | "plugin_source.sync_started"
  | "plugin_source.sync_succeeded"
  | "plugin_source.sync_failed"
  // Primitives
  | "primitive.created"
  | "primitive.updated"
  | "primitive.deleted"
  | "primitive.forked"
  // Bundles
  | "bundle.created"
  | "bundle.updated"
  | "bundle.deleted"
  | "bundle.published"
  // Installations
  | "installation.started"
  | "installation.applied"
  | "installation.failed"
  | "installation.uninstalled"
  | "installation.drift_detected";
```

### Metrics (Prometheus-style labels)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `connectors_sync_duration_seconds` | histogram | `provider`, `status` | Ingest latency SLO |
| `connectors_ingested_primitives_total` | counter | `provider`, `kind` | Catalog growth |
| `installations_materialize_duration_seconds` | histogram | `status` | Install latency SLO |
| `installations_drift_detected_total` | counter | `kind` | Track how often users edit on disk |
| `webhooks_received_total` | counter | `provider`, `verified` | Traffic + security signal |

### Alerts (proposed thresholds)

- Sync failure rate > 5% over 5 min → page.
- Materialization p95 > 30s → warn.
- Webhook verification failures > 10/min → page (likely secret leak or attack).

## Rollout plan

Five slices, each independently shippable behind a feature flag. Previous slices stay on mocks until the backing slice lands.

| Slice | Scope | Feature flag | Gates |
|---|---|---|---|
| 0 | **This PRD** (lands now) | n/a | Merged |
| 1 | Connector-types registry + Integrations CRUD + GitHub adapter + ingester + Primitive + Bundle tables + read-only `GET /v1/orgs/:orgId/{integrations,plugins,primitives,bundles}` | `ff.connectors.read` | Ingest a real repo; Den web Phase 1–3 reads live data |
| 2 | Authoring: `POST/PATCH/DELETE /v1/orgs/:orgId/{primitives,bundles}` + bundle members | `ff.connectors.author` | User can create + edit in-app |
| 3 | WorkspaceInstallation + materialization engine + agents endpoint (`POST /workspace/:id/agents`) | `ff.connectors.install` | Install Bundle from mock Den workspace; file appears on disk; OpenCode loads it |
| 4 | Bitbucket adapter + webhooks | `ff.connectors.bitbucket`, `ff.connectors.webhooks` | Multi-provider + live updates |
| 5 | Publish/export + CLI + universal hook runtime | `ff.connectors.publish`, `ff.connectors.cli`, `ff.connectors.hook_runtime` | Round-trip + ecosystem |

### Mock-removal choreography

For each slice that lands, the Den web side removes exactly one mock file's contents and swaps `queryFn`:

- Slice 1 → `integration-data.tsx` queries hit real endpoints; `plugin-data.tsx` `usePlugins` reads real bundles, still filtered client-side by connected integrations.
- Slice 3 → add `useWorkspaceInstallations()` + new `/workspaces/:id/plugins` page.

### Rollback

Every slice's feature flag is independent. Rolling back slice N leaves slices 0..N-1 intact. Connector-written primitives are soft-deletable (`deletedAt`) so a bad sync can be reverted without data loss.

### Migration

No existing data to migrate — these are all new tables. The existing `/v1/orgs/:orgId/skills` endpoint (skill-hubs) keeps working; slice 1 adds a backfill that copies skill-hub skills into the `primitives` table as `origin = { type: "authored", … }` so they show up in the unified index. Skill-hubs remain as-is for deletion after slice 2.

## Test strategy

### Unit

- **Ingester**: table-driven tests for each shape (`claude-marketplace`, `claude-single`, `opencode-workspace`, `bare-skills`). Golden-file fixtures under `test/fixtures/ingest/`.
- **Connector adapters**: mock GitHub/Bitbucket HTTP with `nock`; assert request construction (scopes, OAuth params, webhook payloads).
- **Materialization**: mock the OpenWork server API; assert correct endpoint + body per primitive kind; assert `appliedPrimitiveDigests` is recorded.
- **Drift detection**: given `{ primitive.contentHash, disk.hash }` permutations, assert correct classification.

### Integration

- **Real GitHub**: a test org + throwaway repo under `different-ai/openwork-test-plugins` with fixture plugins. CI authenticates with a PAT; runs a full ingest + install + uninstall against a temp worktree. Skipped in local unless `OPENWORK_TEST_GITHUB_PAT` is set.
- **Real OpenWork server**: spins up `packaging/docker/dev-up.sh`, provisions a workspace, runs materialization, diffs `.opencode/` against expectations.

### End-to-end

- **Den web** + Chrome MCP: the flow shipped in PRs #1472 / #1475 re-run against real endpoints. Authorize GitHub → select repo → install a bundle → check `/plugins` populates → check `.opencode/skills/` on the worker.
- **Round-trip**: author a Bundle in-app → publish to a repo → ingest that repo from another org → assert Primitives are identical (same `contentHash`) and Bundle membership matches.

### Fuzz / property tests

- **Path safety**: property-test the ingester against random inputs; assert no `../` path ever reaches a write.
- **Drift math**: for any sequence of `(write, user-edit?, uninstall)`, assert uninstall never deletes a file the installer didn't write.

### Regression invariants (asserted in CI)

- `contentHash(ingest(export(bundle)))` === `contentHash(bundle.members.content)` for every primitive kind.
- Installing the same Bundle twice is idempotent (same final disk state, same digests).
- Uninstall after a user edit leaves the file untouched and records drift.

## UI surfaces (where each phase lives)

| Phase | UI surface | Status |
|---|---|---|
| 1. Ingest | `/o/:slug/dashboard/integrations` | ✅ shipped (mock), wire to real API |
| 2. Primitive index | `/o/:slug/dashboard/plugins` — `All Skills` / `All Hooks` / `All MCPs` tabs | ✅ shipped (mock), wire to real API |
| 3. Bundle denomination | `/o/:slug/dashboard/plugins` — list + detail view | ✅ shipped (mock); add `/plugins/new` and `/plugins/:id/edit` for authoring |
| 4. Workspace install | **new**: `/o/:slug/dashboard/workspaces/:workspaceId/plugins` or a tab inside the existing workspace view | 🟡 not yet built |

The new Phase-4 surface shows:

- Currently installed bundles in this workspace (with scope badges: `Workspace` / `User` / `Org`).
- Per-primitive status rows: "Skill `release-prep` → `.opencode/skills/release-prep/SKILL.md` ✓".
- A "browse plugins" CTA that opens `/plugins` in install-mode with this workspace pre-selected.
- Drift indicators when on-disk content no longer matches `applied_primitive_digests`.

Rough visual: same `DashboardPageTemplate` shell, same `DenSelectableRow` for per-primitive status, reuse the `PaperMeshGradient` card per installed bundle.

## Open questions

**Resolved since v1 of this PRD** (keeping for trace):

- ✅ Canonical FS: `.opencode/` is source of truth on disk; DB indexes. Claude `.claude/skills/` paths work natively since OpenCode reads them.
- ✅ Plugin materialization: virtual bundles; primitives written individually to native `.opencode/` paths.
- ✅ Primitive storage: `.opencode/` is source of truth. Remote DB is the org-wide index today; local DB (triggered via a skill) is the future direction.

**Still open:**

1. **Agents mutation endpoint**: OpenWork server has `/workspace/:id/{skills,commands,plugins,mcp}` but **no dedicated agents endpoint**. Options: (a) add `POST /workspace/:id/agents`, (b) use the generic `POST /workspace/:id/files/content` for agents, (c) bundle agents under plugins. Recommend (a) for parity.
2. **Single-plugin repos vs marketplace repos**: both from day one? (Strongly yes.)
3. **Sync strategy**: webhooks-only, webhooks+daily poll fallback, or polling only for v1? Webhooks need a public ingress; for the desktop-hosted case that's harder. Start with polling + manual "sync now", add webhooks as a cloud-only feature.
4. **Installation scope semantics**: how does "org / user / workspace" map onto `orgMembership` / `workspace`? Specifically: can "org" scope auto-install into every newly-created workspace in that org (pre-populate from `extraKnownMarketplaces`-style config)?
5. **Hooks strategy rollout**: confirm A-now, C-later, skip B.
6. **Private package connector**: is npm a v1 target or punt to v1.1? npm adds tarball-fetch + auth.
7. **Client-authored connectors**: "clients can create connectors, or we can" — is that in-scope for v1 (user-registered connector definitions in DB)? Recommend punting to v2 and keeping v1 adapter-registry code-only.
8. **Drift policy defaults**: when a workspace's `.opencode/skills/foo/SKILL.md` differs from the installed Bundle's Primitive, do we (a) prefer disk silently, (b) prefer disk + warn on the Installations page, (c) force a reapply on next install action? Recommend (b).
9. **Bundle versioning semantics**: if a user installs Bundle v1.2 and we re-ingest and now see v1.3, do we auto-update or require an explicit "Update available" click? Recommend explicit click — matches Claude Code's `/plugin marketplace update` semantics.

## What this buys us vs. building a bespoke schema

1. **OpenCode-native materialization** — we don't fight the runtime. OpenCode reads exactly what it already expects; our system produces those files.
2. **Claude-ecosystem compatibility at the skill layer** — `.claude/skills/**/SKILL.md` trees work natively; Claude-style `.claude-plugin/marketplace.json` trees are importable (with agents/commands rehomed at ingest).
3. **Thin connector adapters** — parsing + materialization is shared; each provider is just "auth + fetch tree + webhook verify".
4. **Clean separation of concerns** — Primitives (atoms) ≠ Bundles (groups) ≠ WorkspaceInstallations (projection). Each layer testable in isolation.
5. **Drift-safe uninstall** — `applied_primitive_digests` gives exact reversal without stomping on user edits.
6. **Future-proofs the local-DB pivot** — the `origin.local_mirror` variant is already in the schema; switching SoT from remote-DB-index to local-DB-canonical is additive, not a rewrite.

## Next steps

Mapped directly to [Rollout plan](#rollout-plan) slices:

1. **Land this PRD** (this PR — slice 0).
2. **Slice 1** — ingest → index. Ship behind `ff.connectors.read`.
3. **Slice 2** — authoring. Ship behind `ff.connectors.author`. Covers mock-removal for Phase 3 composer.
4. **Slice 3** — install → materialize. Ship behind `ff.connectors.install`. New `/workspaces/:id/plugins` page + `POST /workspace/:id/agents` endpoint.
5. **Slice 4** — Bitbucket + webhooks.
6. **Slice 5** — publish/export + CLI + universal hook runtime.

Each slice owns its feature flag, mock-removal scope, and rollback plan (see Rollout plan for details).
