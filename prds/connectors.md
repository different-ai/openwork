# Connectors — API surface and FS convention

Status: draft
Owner: src-opn
Scope: OpenWork server + Den web
Related: `/o/:slug/dashboard/integrations` (Den), `/o/:slug/dashboard/plugins` (Den)

---

## Mental model

A **connector** is an adapter in our server that:

1. Authenticates to an external system (OAuth).
2. Given a target in that system (repo / workspace / subdir), fetches a filesystem tree.
3. Runs that tree through a shared **ingester** that parses the Claude-compatible `.claude-plugin/` convention into our domain model (Plugin → Skills / Hooks / MCPs / Agents / Commands).
4. Keeps it fresh via webhooks.

Two separate nouns matter — we should not conflate them:

| Noun | What it is | Who creates it |
|---|---|---|
| **ConnectorType** | The adapter class itself (e.g., "github", "bitbucket", "npm", "local"). Code in our server. | Us — v1 is in-house. v2 could accept plugin-provided adapters. |
| **Integration** | A user's authorized grant + their selected sources (e.g., "this user connected GitHub account `different-ai`, exposed 3 repos"). Persisted, scoped to an org. | The user via OAuth flow. |

The UI already shipped on `/integrations` (PRs #1472, #1475) represents the **Integration** layer. The API below is what would back it.

## FS convention we adopt (verbatim from Claude Code)

Canonical format = Claude's `.claude-plugin/` convention. A connector only needs to produce a filesystem view of this shape; everything downstream is shared.

```
<repo-root>/
├── .claude-plugin/
│   ├── marketplace.json       ← optional: catalog of plugins in this repo
│   └── plugin.json            ← required at plugin root
├── skills/<name>/SKILL.md     ← YAML frontmatter + markdown body
├── agents/<name>.md
├── commands/<name>.md         ← legacy; still supported
├── hooks/hooks.json
└── .mcp.json
```

Single repos can be **either** a marketplace (multiple plugins under `plugins/`) or a single plugin (no `marketplace.json`). Both supported.

**Why this specifically:** adopting Claude's schema means any Claude-compatible plugin on GitHub works in our system with zero re-authoring. Connectors become a pure transport layer.

**Deltas worth discussing:** OpenWork already uses `.opencode/skills/` / `.opencode/plugins/` / `.opencode/commands/`. We should pick one of:

- (a) Claude layout is canonical; `.opencode/` is a per-project reader convention only.
- (b) Both layouts supported; `.opencode/` as primary, `.claude-plugin/` as alias.
- (c) One conversion layer; store in one internal format regardless of source.

Recommendation: **(b)** — dual-read, canonical internal format.

## Data model (backing the API)

```
Organization
  └─ Integration                     1 row per (org × connector_type × provider_account)
     ├─ connector_type               "github" | "bitbucket" | …
     ├─ account                      { id, name, kind: "user" | "org" }
     ├─ credentials_encrypted        access_token, refresh_token, expires_at
     └─ PluginSource[]               1 row per attached repo / subdir / ref
        ├─ locator                   { repo, ref?, path?, sha? }
        ├─ last_sync_at
        ├─ last_sync_status          "ok" | "error" | "pending"
        └─ discovered_plugin_ids[]   fanout to Plugin

Plugin                               1 row per discovered plugin (scoped to org)
  ├─ plugin_source_id                where it came from
  ├─ manifest                        parsed plugin.json
  ├─ version
  ├─ content_hash                    for change detection
  └─ children:
     ├─ Skill[]
     ├─ Hook[]
     ├─ McpServer[]
     ├─ Agent[]
     └─ Command[]

PluginInstallation                   org / user / workspace scope
  ├─ plugin_id
  ├─ scope                           "org" | "user" | "workspace"
  ├─ enabled
  └─ installed_at
```

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
| `DELETE` | `/v1/orgs/:orgId/integrations/:id` | Disconnect; revoke at provider if possible; cascade-delete `PluginSource`s and their `Plugin` rows. |

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
| `DELETE` | `/v1/orgs/:orgId/plugin-sources/:sourceId` | Detach; cascade-delete the Plugins it produced. |
| `POST` | `/v1/orgs/:orgId/plugin-sources/:sourceId/sync` | Force a refresh. |
| `GET` | `/v1/orgs/:orgId/plugin-sources/:sourceId/events` | Sync history (SSE or paginated log). |

### 5. Discovered plugins (the read side — what `/plugins` shows)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/plugins` | All discovered plugins. Supports `?pluginSourceId=…&provider=…&q=…`. Replaces mock `usePlugins()`. |
| `GET` | `/v1/orgs/:orgId/plugins/:id` | Plugin detail + embedded skills/hooks/mcps/agents/commands. Replaces mock `usePlugin(id)`. |
| `GET` | `/v1/orgs/:orgId/skills` | Flat skill index (already exists — would add `pluginId?` and `pluginSourceId?` fields). |
| `GET` | `/v1/orgs/:orgId/hooks` | New — flat hooks. |
| `GET` | `/v1/orgs/:orgId/mcp-servers` | New — flat MCPs. |

### 6. Install / enable (post-discovery)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/orgs/:orgId/plugins/:id/install` | Body: `{ scope: "org" \| "user" \| "workspace", workspaceId? }`. Creates a `PluginInstallation`. |
| `POST` | `/v1/orgs/:orgId/plugin-installations/:id/enable` | |
| `POST` | `/v1/orgs/:orgId/plugin-installations/:id/disable` | |
| `DELETE` | `/v1/orgs/:orgId/plugin-installations/:id` | Uninstall. |

### 7. Webhooks (provider → us)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/webhooks/github` | Signed by `X-Hub-Signature-256`. On `push` to a tracked ref, reindex affected `PluginSource`s. |
| `POST` | `/v1/webhooks/bitbucket` | Equivalent. |

### 8. Admin / health (optional v1.1)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/orgs/:orgId/integrations/:id/diagnostics` | Token expiry, last webhook time, error stream — powers a "something is wrong" banner. |

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

A separate **ingester** (provider-agnostic) takes `FileTree` and runs the Claude-compatible parser:

```
ingest(fileTree):
  if file(".claude-plugin/marketplace.json"): parse → list of plugin roots
  else: treat root as a single plugin
  for each plugin root:
    parse .claude-plugin/plugin.json
    walk skills/*/SKILL.md  → Skill rows (YAML frontmatter + body)
    walk agents/*.md        → Agent rows
    walk commands/*.md      → Command rows
    parse hooks/hooks.json  → Hook rows
    parse .mcp.json         → McpServer rows
    compute content_hash
    upsert into DB
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

## What this buys us vs. building a bespoke schema

1. **Ecosystem compatibility** — `anthropics/claude-code`, `commit-commands`, `github-plugin`, `linear-mcp`, and any third-party marketplace work out of the box.
2. **Cognitive load** — one FS convention for authors to learn; already documented by Anthropic.
3. **Thin adapters** — the surface area per new provider is tiny because all parsing is shared.
4. **Claude Agent SDK parity** — a future "run this plugin locally" flow maps directly to the SDK's `{ type: "local", path }`. Our system = transport + catalog; the runtime is unchanged.

## Open questions

1. **Canonical FS**: `.claude-plugin/` only, `.opencode/` only, or both with alias rules? (Push for both — dual-read, canonical internal format.)
2. **Single-plugin repos vs. marketplace repos**: support both from day one? (Yes, matches Claude.)
3. **Sync strategy**: webhooks-only, webhooks+daily poll fallback, or polling only for v1? Webhooks need a public ingress.
4. **Installation scope semantics**: how does "org / user / workspace" map onto our existing `orgMembership` / `workspace` model? Especially whether workspace-scoped installs need to sync to the OpenWork worker filesystem.
5. **Strict mode** (Claude concept): do we respect `"strict": false` on marketplace entries (marketplace entry is the authority, overrides `plugin.json`)? It's useful for curating a third-party plugin, but adds a conflict-resolution surface.
6. **`CLAUDE_PLUGIN_ROOT` equivalent**: we'd need our own env var for hooks/MCPs at runtime (`OPENWORK_PLUGIN_ROOT`?). Keep it aliased to the Claude var so existing plugins Just Work.
7. **Private package connector**: is npm a v1 target or punt to v1.1? (npm adds a whole tarball-fetch + auth story.)
8. **Client-authored connectors**: "clients can create connectors, or we can". Is that in-scope for v1 (some kind of user-registered connector definition living in DB)? That's a much bigger surface — recommend punting to v2 and keeping v1 adapter-registry code-only.

## Next steps

1. Land this PRD (this PR).
2. Scope out a first API slice: connector-types registry + integrations CRUD + GitHub adapter + ingester, behind the existing Den API.
3. Wire Den web against real endpoints; remove mocks from `integration-data.tsx` and `plugin-data.tsx` (one-line `queryFn` swap, the hook surface stays identical).
