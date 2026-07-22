# Marketplace Capabilities — every published plugin searchable & executable through the rail

Cross-references:

- `evals/org-mcp-connections-ux.md`
- `docs/memory-bank-architecture.md`
- `ee/apps/den-api/src/mcp/README.md`

Status: design note for a Den-only, additive Phase 1.

---

## 1. North star

Every plugin published to an org marketplace is automatically discoverable via `search_capabilities` and reachable via `execute_capability` on the existing `openwork-cloud` connection — the same rail as External MCP Connections.

Installation, meaning copying files into `.opencode/`, becomes an optimization for offline use and pinning, not a requirement for using org-published content.

The marketplace is the FOURTH capability source on the rail, after Den's REST catalog, External MCP Connections, and native provider capabilities. Native provider capabilities already ride the REST catalog as routes tagged `Capability Sources`.

Before:

```text
harness
  └─ openwork-cloud /mcp/agent
       ├─ REST catalog (incl. native provider capability routes)
       └─ External MCP Connections
```

After:

```text
harness
  └─ openwork-cloud /mcp/agent
       ├─ REST catalog (incl. native provider capability routes)
       ├─ External MCP Connections
       └─ Marketplace plugin capabilities   ← new, DB-only
```

The MCP tool surface does not grow. The rail still exposes exactly two tools: `search_capabilities` and `execute_capability`.

---

## 2. Why this is the natural next step

Three precedents already prove the pattern:

1. External MCP Connections merge into `/mcp/agent` search results and execute through the same `execute_capability` tool, with namespaced names from `ee/apps/den-api/src/mcp/external-capabilities.ts` and `needs_connection` pseudo-matches when a member must connect.
2. The memory bank in `docs/memory-bank-architecture.md` says memory is reached by executing a discovered capability, not by registering a bespoke `memory_save` tool.
3. Google Workspace native capabilities are plain Den REST routes tagged `Capability Sources`, then auto-surfaced through the REST catalog.

The marketplace source is the cheapest of the four: indexed DB rows, pre-derived `ConfigObjectTable.searchText` (`title\ndescription\nrawSource`), no live `tools/list`, no network, no new auth, and no new execution machinery for instructional content.

---

## 3. Capability classes

A config object's `objectType` determines its execution semantics on the rail.

| objectType | phase-1 search | phase-1 execute | notes |
|---|---|---|---|
| `skill` | searchable | instructional payload with latest version `rawSourceText` | Generalizes local skill progressive disclosure: the harness skill tool returns `SKILL.md` content on invoke, but this is org-wide with zero install. |
| `context` | searchable | instructional payload with latest version `rawSourceText` | Content is framed as org marketplace context with provenance. |
| `custom` | searchable | instructional payload with latest version `rawSourceText` | The rail does not interpret custom content beyond provenance and grants. |
| `agent` | searchable | instructional payload with latest version `rawSourceText` | Served as instructions the primary agent can adopt; real spawn-subagent integration is out of scope. |
| `command` | searchable | accepts `body: { arguments?: string }`, substitutes `$ARGUMENTS`, returns rendered template | Instructional with arguments. No command is run server-side. |
| `mcp` | searchable | returns declared server spec plus `status`/`hint` guidance | If an External MCP Connection for the same URL exists, hint to search for that connection's tools. Otherwise hint that an org admin can add it in Cloud → Connections, or the user can install locally. No auto-provisioning in Phase 1. |
| `tool` | searchable | returns source plus `status: "needs_install"` and a hint naming the plugin/marketplace | Local-only in Phase 1. A human, or the agent via the desktop install flow, can finish locally. Phase 3 option: sandboxed execution via Den Worker Runtime. |
| `hook` | searchable metadata only | returns definition plus an unsupported hint | Hooks are not supported anywhere yet: `apps/server/src/claude-plugin-bundle.ts` warns that OpenWork does not support hooks, and local install skips loading them. |

Instructional payloads include provenance framing: `Content from marketplace plugin <plugin> in your organization's library.` The agent sees where the text came from before deciding how to use it.

Degraded states:

1. `content_not_synced`: a config object exists, but no latest version exists yet. This is real for seeded starter catalogs whose content arrives later via the GitHub connector. Execute returns `status: "content_not_synced"` with a hint to connect or sync the source.
2. Seeded plugins with no config objects: nothing is indexed, so they simply do not match. This is correct and honest because there is no executable content yet.

---

## 4. Naming & wire shape

Namespace:

```text
plugin:<pluginId>:<configObjectId>
```

This mirrors `mcp:<connectionId>:<toolName>`. IDs are stable and org-scoped. `parseMarketplaceCapabilityName` distinguishes marketplace names from `mcp:` names and REST catalog operation names in the execute handler.

These names are data in search results and execute arguments. They are not registered MCP tool names, so MCP tool-name length limits do not apply; this is the same pattern External MCP Connections use today.

Base match type from `ee/apps/den-api/src/mcp/search.ts`:

```ts
export type CapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
  pathParams: string[]
  queryParams: string[]
  hasBody: boolean
}
```

Marketplace match shape:

```ts
type MarketplaceCapabilityMatch = CapabilityMatch & {
  kind: ConfigObjectType
  plugin: string
  marketplace?: string
  status?: "needs_install" | "content_not_synced"
  hint?: string
}
```

Required marketplace match fields:

- `method: "PLUGIN"`.
- `path: plugin://<plugin-slug>/<currentRelativePath>`.
- `pathParams: []`.
- `queryParams: []`.
- `hasBody: true` only for `command`; otherwise `false`.

Instructional execute result is structured JSON text content:

```json
{
  "kind": "skill",
  "plugin": "Plugin name",
  "marketplace": "Marketplace name",
  "name": "Config object title",
  "description": "Config object description",
  "content": "...latest rawSourceText...",
  "provenance": "Content from marketplace plugin Plugin name in your organization's library."
}
```

Bridged, local-only, and degraded classes return the same envelope plus `status` and `hint`.

Errors mirror External MCP's contract: `unknown_capability`, `forbidden`, and `content_not_synced`. Gated-off orgs get `unknown_capability`; search returns no marketplace matches. Disabled is indistinguishable from nonexistence: the byte-identical principle.

The tool surface stays EXACTLY two tools. `evals/flows/mcp-search-capabilities.flow.mjs` keeps passing unchanged with `[execute_capability, search_capabilities]`.

---

## 5. Search & visibility semantics

New module: `ee/apps/den-api/src/mcp/marketplace-capabilities.ts`, mirroring `ee/apps/den-api/src/mcp/external-capabilities.ts`.

Search entry point:

```ts
searchMarketplaceCapabilities({ organizationId, member, query, limit })
```

Visible set for a member = active config objects reachable through direct `ConfigObjectAccessGrantTable` grants, `PluginAccessGrantTable` grants cascading to config objects, or `MarketplaceAccessGrantTable` grants cascading to plugins and config objects.

Grant targets are `orgWide`, `orgMembershipId`, or `teamId`; roles are `viewer | editor | manager`; `viewer` is sufficient to search and execute.

Use the pure function `resolvePluginArchGrantRole({grants, memberId, teamIds})` from `ee/apps/den-api/src/routes/org/plugin-system/access.ts`. Do NOT call the HTTP-context-coupled `resolvePluginArchResourceRole`; `/mcp/agent` has `McpMemberIdentity` (`memberId` + `teamIds`), not a route session context. A small set-oriented adapter is needed.

Org admins, resolved via `MemberTable` role / `isOwner`, see all active objects.

Status filters are strict:

- Marketplace, plugin, and config object must be active.
- `MarketplacePluginTable` and `PluginConfigObjectTable` links must not be removed.

Scoring reuses `tokenize` / `scoreText` from `ee/apps/den-api/src/mcp/search.ts`: title tokens `+5` exact / `+3` prefix, description `+2`, `searchText` `+1`.

Marketplace matches are interleaved with the other sources by score in `ee/apps/den-api/src/mcp/agent.ts`, exactly like External MCP matches are today.

Search is DB-only, bounded by `limit`, and makes no live network calls. This contrasts with External MCP Connections, where search may call `tools/list` through `ee/apps/den-api/src/capability-sources/external-mcp-client.ts`.

Dedupe against locally installed copies is NOT server-side possible in Phase 1. Den does not know what a desktop copied into `.opencode/`. Defer dedupe; make duplicates distinguishable with marketplace/plugin provenance in summaries and execute payloads.

---

## 6. Execute semantics

Add `executeMarketplaceCapability(...)` in `ee/apps/den-api/src/mcp/marketplace-capabilities.ts`.

Add a branch in `ee/apps/den-api/src/mcp/agent.ts`'s execute handler between the `mcp:` External MCP branch and the REST catalog lookup.

Steps:

1. Parse `plugin:<pluginId>:<configObjectId>`.
2. Gate check; see §7.
3. Load the config object scoped to the calling org.
4. Verify membership in the named plugin through `PluginConfigObjectTable`.
5. Check grants through the cascade adapter; `viewer` suffices.
6. Load the latest version using the same indexed pattern as `ee/apps/den-api/src/routes/org/plugin-system/store.ts`'s `getLatestVersions`, backed by `config_object_version_lookup_latest`.
7. Let `encryptedTextColumn` decrypt `rawSourceText` and `normalizedPayloadJson` transparently.
8. Apply the per-class behavior from §3.

Scope note: these are `mcp:read`-class operations; nothing on this path writes; there is no new auth, no new policy file, and no new execution logic beyond the branch. This mirrors `ee/apps/den-api/src/mcp/agent.ts`'s philosophy.

---

## 7. Org kill switch

Marketplace capability search/execute uses the same effective Connect rail check
as External MCP connections: `memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled })`
in `ee/apps/den-api/src/capability-sources/external-mcp-rollout.ts`.
`gatingEnabled` and `DEN_MCP_CONNECTIONS_GATING_ENABLED` are deprecated and
inert; they stay wired only so existing deployment configs and call sites keep
working.

Org metadata kill-switch key:

```json
{ "capabilities": { "mcpConnections": false } }
```

Connect is default-on, so local dev, self-hosted, evals, and hosted production
get the feature immediately unless an org explicitly opts out. The backoffice
capability value outranks legacy flat aliases (`connectEnabled` and
`mcpConnectionsEnabled`).

Check the kill switch in both paths: disabled orgs get an empty marketplace
merge; execute returns `unknown_capability`. Opted-out is byte-identical to
nonexistence.

### Additive invariants

1. Desktop users without the cloud connection: this code is unreachable; zero change.
2. Cloud-connected users in opted-out orgs: byte-identical search results and execute behavior.
3. Tool surface unchanged: still exactly `search_capabilities` + `execute_capability`.
4. The desktop install flow (`apps/server/src/cloud-plugins.ts`) is untouched; installed plugins keep working identically; nothing migrates, nothing is deprecated in Phase 1.
5. The rich `/mcp` endpoint and `/mcp/admin` are untouched. External connections also merged only into `/mcp/agent`.
6. No schema changes, no migrations, no new tables in Phase 1; everything derives from existing plugin-arch tables in `ee/packages/den-db/src/schema/sharables/plugin-arch.ts`.
7. No prompt changes and no tool-description changes in Phase 1; results are self-describing via `summary`, `status`, and `hint`.

Kill switch uses the same layer as connections: flip org metadata in /admin (or
an ops script) by setting `metadata.capabilities.mcpConnections` to `false`.
The old deployment-level env gate is deprecated and inert.

---

## 8. Phase plan

### Phase 1: this document's scope, Den-only, additive

Build the marketplace search source, the execute branch for all classes with honest statuses, the org kill switch, tests, and eval flow. There are zero desktop changes; member-facing Connect rail behavior is default-on unless an org explicitly opts out.

Deliverables:

- New: `ee/apps/den-api/src/mcp/marketplace-capabilities.ts`.
- Touched: `ee/apps/den-api/src/mcp/agent.ts` at the two merge points.
- Touched: `ee/apps/den-api/src/env.ts`.
- New: `ee/apps/den-api/test/marketplace-capabilities.test.ts`.
- New: `evals/flows/marketplace-capabilities.flow.mjs`.
- New: `docs/marketplace-capabilities-architecture.md`.

Not in Phase 1: desktop UI, prompt edits, tool-description edits, schema changes, local rail parity, MCP auto-provisioning, sandboxed tool execution, dedupe against local installs, or retiring copy-install.

### Phase 2: make the bridge real, still no removal

Provision an External MCP Connection from a plugin's `mcp` spec; add nullable `sourcePluginId` linkage column as the first schema change; add inline connect cards; add desktop provenance / "Available via Cloud — no install needed" states in the Extensions UI; add search-side hints for already-installed dedupe; add one-line teaching in the OpenWork agent prompt and `/mcp/agent` tool descriptions; add command argument schemas.

### Phase 3: retire the requirement to copy

Add sandboxed `tool` execution via Den Worker Runtime; add `tools/searchText` caching if scale demands; add LOCAL rail parity so the local OpenWork server (`apps/server`) grows the same search/execute surface over locally-known catalogs for signed-out users; reposition copy-install as "pin locally / offline".

---

## Phase 2 — cloud-native plugins (capability records)

Status: designed 2026-07-07, tabled — Part 1 (readiness partition) ships first.

Phase 2 replaces "derive at read time" with versioned `CapabilityRecord`s compiled when a marketplace plugin is published or synced.

Each record is an immutable description of one runnable or installable unit:

```ts
type CapabilityRecord = {
  id: string
  pluginId: string
  versionId: string
  name: string
  kind: "skill" | "command" | "agent" | "context" | "mcp" | "tool" | "hook" | "custom"
  executionMode: "den_instructional" | "external_mcp" | "desktop_install" | "reserved_sandbox"
  requirements: Array<{ kind: "connection" | "member_signin" | "desktop"; ref?: string }>
  bundleRef: string
}
```

Compile-at-publish means search reads ready-to-index rows rather than reparsing plugin config objects on every request. A publish transaction writes all records for the new plugin version, then atomically swaps the marketplace pointer from the previous record set to the new set.

Skill envelopes keep the Claude plugin directory contract as the source bundle. The bundle remains compatible with `apps/server/src/claude-plugin-bundle.ts`: a Claude plugin directory with skills, commands, MCP declarations, and metadata. Den stores a `bundleRef`, then the runtime mounts that bundle into an ephemeral harness view when instructional content is executed.

Instructional records (`skill`, `command`, `context`, `agent`, `custom`) execute by returning a signed envelope: provenance, raw content, arguments schema when present, and a short-lived bundle mount reference. They still do not run arbitrary code inside den-api.

Plugin `.mcp.json` content compiles into connection templates. A template has a stable name, normalized URL, declared auth mode, and optional provider hints. At org setup time, templates bind to the existing External MCP machinery rather than creating a parallel credential store.

The binding layer is the same one used today for External MCP Connections: org admins create or approve the connection once, members complete per-member OAuth when required, and the rail merges discovered remote tools under the existing `search_capabilities` / `execute_capability` grammar.

Desktop-install records (`tool`, `hook`, built-in extension manifests, unsupported local files) intentionally stay out of Connect. They are visible only on desktop install surfaces, with the same bundleRef so the desktop can copy the exact versioned payload.

The sandbox arm is reserved, not chosen. Two candidates remain open:

1. Den Worker running `opencode-server` with a constrained workspace and mounted bundle.
2. Claude Agent SDK runner with a plugin bundle adapter.

Both require a stronger isolation and billing story than Part 1 needs. Until that decision is made, `tool` records stay `desktop_install` or `reserved_sandbox` with no execution path.

Records are versioned and atomically swapped. A marketplace reader either sees all records for version N or all records for version N+1; it never sees a half-compiled mix. Old record sets can be retained for rollback and audit until the source plugin is archived.

Capability records also make readiness cheap: state is a projection over `executionMode` plus bound connection/member auth status, not a fresh parse of every config object. The PR 6 readiness contract is the user-visible partition that this later record model preserves.

No Den worker executes anything on the rail today. Part 1 and PR 6 are den-api in-process only: DB reads, readiness classification, instructional payloads, and external-MCP handoff through existing connection infrastructure.

---

## 9. Security & trust considerations

1. Marketplace content is org-curated but still third-party text. Instructional payloads are prompt-injection surface. Mitigations: provenance framing in every payload; the existing desktop invariant that agents do not auto-open tool-output URLs; strict grants; org admins control what is published.
2. Encrypted-at-rest payloads decrypt only inside den-api through existing `encryptedTextColumn` machinery. Nothing new leaves the org boundary.
3. No secrets should live in config objects. The connections machinery remains the only credential store, and Phase 1 never touches it.
4. SSRF risk is avoided in Phase 1 because this path makes zero outbound calls. The Phase 2 bridge inherits the existing guarded MCP client.

---

## 10. Test & proof plan

Unit tests in `ee/apps/den-api/test/marketplace-capabilities.test.ts`:

1. Grant cascade: org-wide marketplace grant ⇒ member finds plugin skill.
2. No grant ⇒ no match and no allowed execute.
3. Team grant visibility.
4. Admin sees all active objects.
5. Gating byte-identity: gated org gets empty marketplace search merge and `unknown_capability` execute.
6. Name build/parse round-trip.
7. Scoring sanity.
8. Command `$ARGUMENTS` substitution.
9. `content_not_synced`.
10. `hook` / `tool` statuses and hints.

Existing contract must keep passing untouched: `evals/flows/mcp-search-capabilities.flow.mjs` asserts exactly two tools.

New eval flow `evals/flows/marketplace-capabilities.flow.mjs`: seed marketplace + plugin + skill config object via the plugin-system API → real chat turn → assert `search_capabilities` returns the `plugin:` match → `execute_capability` returns the skill content → the answer reflects the skill's instructions; control frame proves an opted-out org sees no `plugin:` matches.

Fraimz proof follows `AGENTS.md`: `evals/results/<run-id>/fraimz.html` exists, and every claim is backed by an observable assertion and screenshot.

---

## 11. Deliberately open questions

1. Whether `none`-auth remote MCP specs could be proxied directly in Phase 1 without a connection row. It is credential-safe, but adds live network to search. Decision for Phase 1: no; revisit in Phase 2 with the bridge.
2. Whether search should read `normalizedPayloadJson` frontmatter, such as skill `description`, instead of raw `searchText` for cleaner summaries. Phase 1 uses stored `title`, `description`, and `searchText`.
3. Slug-based display names versus raw IDs in `path`. This is cosmetic and cheap to change until Phase 2 freezes the contract.
