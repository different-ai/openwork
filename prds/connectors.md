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

1. Land this PRD (this PR).
2. **API slice 1 (ingest → index)**: connector-types registry + integrations CRUD + GitHub adapter + ingester + Primitive/Bundle tables. Behind the existing Den API.
3. **Wire Den web Phase 1–3**: replace mocks in `integration-data.tsx` and `plugin-data.tsx` with real calls; no shape change to React Query hooks.
4. **API slice 2 (install → materialize)**: WorkspaceInstallation + materialization engine. Reuses the existing `/workspace/:id/{skills,commands,plugins,mcp}` endpoints.
5. **New Den page**: `/o/:slug/dashboard/workspaces/:workspaceId/plugins` (Phase 4 surface).
6. **Hooks strategy**: ship option A as part of the ingester; file C as a separate workstream.
7. **Bitbucket adapter**: after GitHub ships cleanly.
8. Land `POST /workspace/:id/agents` on the OpenWork server (needed for agent materialization).
