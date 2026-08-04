# Grant-Native Skill Sharing Program

Make access to skills a grant edge, not a marketplace membership. A skill you
create in chat is usable in your next message; sharing it with a person or a
team is one grant row; marketplaces are demoted to what they really are —
browsable catalogs.

## Goal

- A cloud skill created from the chat (`create-skill` builtin → `POST
  /v1/plugins`) is immediately discoverable and executable by its creator via
  `search_capabilities` / `execute_capability` — no marketplace involved.
- Sharing with a person, a team, or the whole org is a single
  `plugin_access_grant` row, drivable from chat.
- The dashboard shows one library ("Mine / Shared with me / Team / Everyone")
  with provenance on every row.
- Org admins can set a sharing posture (Open / Team-scoped / Curated) without
  a deploy.
- Marketplaces keep working exactly as today for catalogs (OpenWork defaults,
  Anthropic starters, GitHub imports). Nothing is deleted.

## Short answer

This is four independent phases, each shippable alone. The root defect is one
pair of SQL queries: the chat capability index builds its candidate set by
inner-joining `marketplace_plugin` + `marketplace`
(`ee/apps/den-api/src/mcp/marketplace-capabilities.ts:331-372` and `:374-422`),
so a plugin outside an active marketplace is invisible in search and returns
`unknown_capability` on execute — even for its creator, who already holds a
`manager` grant written at creation
(`ee/apps/den-api/src/routes/org/plugin-system/store.ts:1984-1994`). Grants are
already consulted, but only as a *filter* (`filterVisibleRows`, `:478-508`)
over rows that survived the marketplace join.

Everything else in the model already exists: `plugin_access_grant` supports
`orgMembershipId | teamId | orgWide` with `viewer/editor/manager`
(`ee/packages/den-db/src/schema/sharables/plugin-arch.ts:228-250`), and
`resolvePluginArchGrantRole` resolves all three shapes
(`ee/apps/den-api/src/routes/org/plugin-system/access.ts:183-199`). Phase 1
requires **zero schema migrations**.

## Current coupling (verified)

| Fact | Where |
|---|---|
| Candidate set requires an active marketplace membership (inner joins) | `marketplace-capabilities.ts:331-372` (search/descriptors/references), `:374-422` (execute) |
| Grants only filter, never admit | `filterVisibleRows` `:478-508`; `grantRole` → `access.ts:183-199` (skips `removedAt`, `maxRole` viewer<editor<manager; **no admin bypass by design**, comment `:500-503`) |
| Capability name encodes plugin+configObject only — `plugin:<pluginId>:<configObjectId>` | `buildMarketplaceCapabilityName` / `parseMarketplaceCapabilityName` `:210-223` |
| Execute payload requires `marketplace: string` | `MarketplaceCapabilityExecutePayload` `:136-151`; fed by `basePayload` `:306-315` |
| Search match `marketplace?` and descriptor `marketplaceName?` are already optional | `:100-108`, `:39-47` |
| References require `marketplaceId` and dedupe on it | `:49-54`, `:524-538`; consumed by `GET /v1/resources/marketplace-capabilities` (`routes/org/resources.ts:257-291`) |
| Plugin in N marketplaces → N rows; deduped by capability name in search (`:1250-1251`) and by capability in descriptors (`:561`); winner = alphabetically first marketplace (`orderBy` `:370`, `:420`) | search `:1218-1288`, descriptors `:541-581` |
| Marketplace-name strings in user-facing copy | `summaryFor` `:287-291`, `objectHint` `:279-281`; `provenance()` `:275-277` uses plugin name only |
| MCP-requirement + cloud-readiness machinery is marketplace-independent | `resolveMarketplacePluginCloudReadiness` `:1073-1155` (joins only plugin⋈configObject); `marketplaceMcpServerEntries` `:638-651` |
| Creator gets `manager` grant at plugin creation | `store.ts:1968-1998` |
| `create-skill` builtin tells the agent the skill is "private until published or shared" | `ee/apps/den-api/src/mcp/builtin-skills.ts:27,62-63,163` |
| Chat consumers of this module | `mcp/agent.ts:416-432` (skill resources), `:483-492` (search tool), `:563-582` (execute tool) |

## Target architecture

```
 WHO                        EDGE (one row each)                WHAT
 ───                        ───────────────────                ────
 creator ─────────────── manager grant (auto on create) ──┐
 person  ─────────────── viewer grant  ("share w/ Ben")  ──┤
 team    ─────────────── viewer grant  ("share w/ team") ──┼─▶ PLUGIN ─▶ SKILL(s)
 org     ─────────────── org-wide grant (admin)          ──┤
 catalog (marketplace) ── membership   (browse ▸ add)    ──┘

 capability index candidate set: ConfigObject ⋈ PluginConfigObject ⋈ Plugin
   LEFT JOIN marketplace membership          (was: INNER JOIN)
 visibility: unchanged filterVisibleRows — configObject grant, plugin grant,
   or marketplace grant when a marketplace edge exists
```

Permission gate (Phase 4): org capability (`plugin.share_member|share_team|
share_org|grant_editor`, added to the `PluginArchCapability` union,
`access.ts:18-20`) AND `manager` on the plugin. Default grant role on every
share: `viewer`. Recipients can never re-share.

## Phases

### P1 — Grant-native capability index (this PR)

Candidate set moves from "marketplace-attached" to "grant-reachable ∪
marketplace-attached"; everything downstream keeps working.

1. `listActiveMarketplaceRows` / `listActiveMarketplaceRowsForCapability`:
   inner join on `marketplace_plugin`+`marketplace` becomes LEFT JOIN
   (membership `removedAt IS NULL` and marketplace active/undeleted move into
   the join condition). Row type: `marketplace: MarketplaceRow | null`.
2. `filterVisibleRows`: skip the marketplace-grant path when `marketplace` is
   null. Grant-only rows must carry a config-object or plugin grant to pass —
   same rule as today, minus the mandatory catalog hop.
3. Payloads: `MarketplaceCapabilityExecutePayload.marketplace` →
   `string | null`; `basePayload`, `summaryFor` (`[Plugin] title` when no
   catalog), `objectHint` fallback copy. Search-match `marketplace?` and
   descriptor `marketplaceName?` stay optional and simply omit.
4. References (`AccessibleMarketplaceCapabilityReference.marketplaceId`) →
   `string | null`; dedupe key already includes plugin+configObject. Verify
   consumers of `/v1/resources/marketplace-capabilities` tolerate null before
   changing; if any consumer hard-requires it, exclude null-marketplace rows
   from that route only and note it here.
5. Determinism: plugins with catalog membership never produce a
   null-marketplace row (LEFT JOIN yields null only when no membership), so
   existing payloads are byte-identical; keep `orderBy` marketplace-name for
   multi-catalog winners.
6. `builtin-skills.ts`: `create-skill` copy — the skill is usable by its
   creator immediately; report that instead of "private until published".
   Keep "Do not send `marketplaceId` or `orgWide`."
7. Sweep steering copy that asserts the old behavior
   (`mcp/agent.ts:117`, `apps/server/src/opencode-plugins/
   openwork-extensions-preview-steering.ts:141`,
   `openwork-capabilities-knowledge.ts:95`) — update only if they state
   "unusable until published".

**Proof (spec acceptance, run with `bun test` — this program uses spec
acceptance criteria + suites instead of fraimz, per program owner decision):**

- New suite `ee/apps/den-api/test/grant-native-capabilities.test.ts`
  (pattern: copy of `test/marketplace-capabilities.test.ts` harness, own
  `openwork_test_*` database):
  - A1 creator: plugin+skill with member `manager` grant, **no marketplace**
    → search finds it, execute returns raw SKILL.md content, descriptors
    include it, `marketplace` is null/omitted in payloads.
  - A2 team: team-scoped `viewer` grant, no marketplace → visible/executable
    for a team member, invisible + `forbidden`/`unknown_capability` for a
    non-member.
  - A3 nobody: active plugin+skill, zero grants, no marketplace → not in
    search, execute denies.
  - A4 unchanged: marketplace-attached plugin behaves exactly as before
    (payload carries the marketplace name).
  - A5 both: plugin in a catalog AND direct grant → exactly one search match,
    marketplace name still present.
- Full existing suites stay green: `test/marketplace-capabilities.test.ts`,
  `test/marketplace-cloud-readiness.test.ts`,
  `test/plugin-system-create-bundle.test.ts`.
- `tsc --noEmit` clean for den-api.

#### P1 results — PASSED (verified 2026-08-01, branch `feat/grant-native-skills`)

- Two-query design as specified: existing inner-join queries byte-identical;
  grant-only candidates via `notExists` active-membership subquery
  (`listGrantOnlyRows`, `listGrantOnlyRowsForCapability`); execute falls back
  to the grant-only resolver only when the marketplace resolver returns zero
  rows.
- **Step-4 decision:** internal references now carry
  `marketplaceId: string | null` (null sorted last); the desktop route
  `GET /v1/resources/marketplace-capabilities` filters out null-marketplace
  rows because its consumer requires marketplace ids — grant-only skills reach
  chat via search/execute/descriptors, not that route. Revisit in P3.
- **Step-7 outcome:** steering copy in `mcp/agent.ts`,
  `openwork-extensions-preview-steering.ts`, `openwork-capabilities-knowledge.ts`
  made no stale "unusable until published" claims — unchanged.
- Proof: `bun test test/grant-native-capabilities.test.ts
  test/marketplace-capabilities.test.ts test/marketplace-cloud-readiness.test.ts
  test/plugin-system-create-bundle.test.ts` → **63 pass / 0 fail**
  (5 new A1–A5 + 58 existing); `pnpm exec tsc --noEmit` clean.
  Per program owner decision, proof is spec acceptance suites, not fraimz.

#### P1 wire proof — spec lane (verified 2026-08-01)

`evals/specs/skill-grant-access.test.ts` proves the claim over the exact
surface desktop chat uses — `POST /v1/mcp/token` → `POST /mcp/agent`
(Streamable HTTP JSON-RPC `tools/call`): the seeded owner creates a
plugin+skill via `POST /v1/plugins` (no `marketplaceId`/`orgWide`, the
`create-skill` contract), then `search_capabilities` (with and without
`type: "skills"`) returns the capability with no `marketplace` field,
`execute_capability` returns the raw SKILL.md with `marketplace: null`, and a
freshly invited member (real invitation → signup → accept flow) neither
discovers it nor executes it (exact denial:
`{"error":"forbidden","message":"You have not been granted access to this
marketplace plugin capability."}`). Runs in the `pr` project (fast lane),
env-gated skip without a stack.

Workflow to reproduce from a worktree (MySQL docker on :3306):

```bash
pnpm dev:den:db-push
DEN_ORG_MODE=multi_org pnpm dev:den:api        # :8790; demo:den also uses multi_org.
                                               # The spec self-diagnoses disabled signup;
                                               # DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=true also works.
DEN_DEMO_SEED_FETCH_GITHUB=0 pnpm --filter @openwork-ee/den-api run seed:demo-org -- --reset
export OPENWORK_EVAL_DEN_API_URL=http://127.0.0.1:8790
export OPENWORK_EVAL_DEN_WEB_URL=http://localhost:3005
export OPENWORK_EVAL_MARK_VERIFIED_CMD='docker exec openwork-web-local-mysql mysql -uroot -ppassword openwork_den -e "UPDATE \`user\` SET email_verified = 1 WHERE email = '\''{email}'\''"'
pnpm --dir evals install && pnpm --dir evals run spec specs/skill-grant-access.test.ts
```

Results: spec passes against a pristine `--reset` seed (both the
invitation-bootstrap and direct-sign-in paths); full `pr` lane
`pnpm --dir evals run spec` → 3 files / 5 tests passed; skip path verified;
`pnpm --dir evals run typecheck` clean.

**Discovered while proving (feeds P4):** `hasPluginArchCapability` ignores its
capability argument — every plugin-arch capability is admin/owner-only today
(`access.ts:101-103`). So member-level skill creation does not exist yet;
P1's "creator" claim holds for whoever may create (admins/owners), and
opening `plugin.create` per posture is exactly P4's job. The P4 pre-flight
question about the capability→role mechanism is answered: it is a stub to
replace.

### P2 — Share verbs in chat

New builtin `share-plugin` skill (person/team/org → writes a
`plugin_access_grant` via the plugin access routes; verify they are exposed —
`createResourceAccessGrant` exists in `store.ts`). `create-skill` gains the
post-create "share it?" offer. Same-creator+same-name plugin creation → 409
pointing at the existing id. Verify `syncPluginMcpRequirementAccessForResource`
fires on grant creation as it does on marketplace attach (`store.ts:2626-2658`).
Hardcoded Team-scoped defaults (person ✔, own team ✔, org admin-only).
Proof: suite covering grant writes, recipient visibility via P1 index,
non-manager denial, recipient cannot re-share.

#### P2 results — PASSED (verified 2026-08-02, branch `feat/p2-share-verbs`)

- `share-plugin` builtin (`skill:share-plugin`): getOrg → postPluginsAccess →
  getPluginsAccess; viewer by default, editor only on explicit ask, org-wide
  relayed as admin-only; never invents ids. `create-skill` offers sharing
  after creation and handles `409 duplicate_plugin` by steering to the
  version-update path.
- Duplicate guard: same creator + same trimmed name + active → 409 with the
  existing plugin id (`createPlugin`); archived names reusable; other
  creators unaffected. Admin GitHub re-imports of an identical name now 409
  (accepted; aligns with the dedup goal).
- Grant-creation MCP-requirement sync confirmed wired (`store.ts:1887,1895`).
- Proof: 53/53 bun (builtin search/execute/resources, dup semantics,
  member-grant → recipient search+execute with `marketplace: null`, viewer
  cannot re-share) + 19/19 server steering tests + den tsc clean; wire spec
  `skill-grant-access.test.ts` extended to the full story — member creates →
  uses → second member denied → creator shares viewer → second member
  discovers and executes → recipient re-share 403 — passing 3× against a
  live multi_org stack; evals typecheck clean.

### P3 — Library UI + provenance

#### P3 PR3 — member library + mobile + debt retirement (shipped)

Design: Paper pages "PR3 — Member library placement" + "Mobile treatment —
A/B/C" (user-approved). Shipped: member-visible `dashboard/library` route
(outside the admin gate, next to Your Connections) rendering the Screen C
library — audience tabs (All / Mine / Shared with me / Team / Everyone),
search, one card per plugin with stacked provenance chips incl. the GitHub
source chip; backed by new `GET /v1/me/plugin-access` (caller-scoped edges:
mine / person+sharedBy / team / org_wide / catalog; role capped viewer via
catalogs). The program's only migration landed: `plugin.source_repository_url`
populated by GitHub import + discovery. Desktop grant-only filter LIFTED on
/v1/resources/marketplace-capabilities (consumer made null-tolerant in
apps/app). Marketplace copy strings retired (forbidden message + provenance).
Mobile: Page 4 pattern applied — library mobile-first, PR1 team grid and PR2
access rows retrofitted to stacked cards below md, share picker becomes a
centered dialog on small screens. Proof:
`evals/specs/library-view.slow.test.ts` — member API edges asserted for
creator and recipient, desktop-filter lift asserted (marketplaceId null row),
browser leg AS A PLAIN MEMBER with a two-frame photo roll (desktop + 375px
mobile), vision 4/4. The browser leg caught and fixed a sharedBy parser
mismatch — the member-perspective spec paying for itself.

#### P3 PR2 — plugin access panel (shipped)

Design: Paper file page "PR2 — Skill access panel" (user-approved). Shipped:
"WHO CAN ACCESS THIS" section on plugin detail (stacked section, no tabs) —
people/team rows with role pills and shared-by provenance, AccessAddPicker
share flow with plain-words role choice ("Can view" default, "Can edit"
behind a select with an amber consequence line), org-wide switch rendered
ONLY for admins (server 403s members — hide, don't disable), creator
provenance under the header, and a computed blast-radius line on the archive
confirm. No new API (existing grant routes; serializer already exposed
creator fields). Proof: `evals/specs/plugin-access-panel.slow.test.ts` — API
leg (creator grants person + team; grant list asserted) + browser leg with
vision-validated photo roll; org-wide toggle asserted PRESENT for admin.
Known limitation discovered: the den-web `(admin)` route group redirects
plain members away from plugin detail — member-facing surfaces are a PR3
decision (the member library cannot live behind the admin gate).

#### P3 PR1 — team access view (shipped from this branch)

Design source: Paper file "P3 — Access Visibility" (screens annotated with
den-web primitive mappings and NEW rationale). Shipped: `GET
/v1/teams/:teamId/plugin-access` (direct_team / via_catalog / org_wide edges,
server-side grantor names, admin-or-team-member gated) + den-web team detail
page (Members ▸ Teams ▸ team name) with Overview and Access tabs — the
members-grid pattern, edge badges on DenBadge tones, amber editor rows,
Revoke for direct grants, Open catalog for inherited ones. Proof:
`test/plugin-system-team-access.test.ts` (route-level, real MySQL) +
`evals/specs/team-access-view.slow.test.ts` (API leg + headless-Chrome
browser leg with vision-validated photo roll of the real screen).

Dashboard library: Mine / Shared with me / Team / Everyone, one row per
plugin, provenance chips (Yours / Shared by N / Team T / catalog M /
built-in), per-skill access list, revoke, delete blast-radius warning.
Persist GitHub source URL on imports if absent (only migration candidate in
the program). Proof: den-web component tests + P1/P2 suites; manual demo per
north star.

### P4 — Postures

`plugin.share_member|share_team|share_org|grant_editor` in the
`PluginArchCapability` union; role wiring (verify capability→role mapping
mechanism at `access.ts:366-373` and where org role permissions persist);
settings screen with Open / Team-scoped / Curated presets. Proof: suite
asserting each posture's allow/deny matrix.

## Risks

1. **Over-exposure regression** — the index gets *wider*. Mitigated: admission
   still requires a live grant (`filterVisibleRows` unchanged in semantics);
   A3/A4 pin it; the deliberate no-admin-bypass comment (`:500-503`) is
   preserved and tested by the existing suite (`test/marketplace-capabilities
   .test.ts:516`).
2. **Reference-shape consumers** — `marketplaceId: null` may surprise the
   desktop resources route consumer. Checked in P1 step 4; excluded from that
   route if unsafe.
3. **Search noise** — grant-only rows enlarge the candidate scan. Same
   order-of-magnitude as today (org-scoped joins); revisit only if orgs with
   thousands of plugins appear.
4. **Copy drift** — agent-facing SKILL.md text (`builtin-skills.ts`) and
   steering prompts must agree with the new behavior or agents will
   "helpfully" attach marketplaces. P1 steps 6–7.

## North-star demo

1. I ask OpenWork to create a skill that formats my standup notes; it
   confirms the skill is ready to use — no publish step, nowhere to browse.
2. In the same chat I ask it to use the skill, and it just works.
3. I say "share it with Ben"; Ben asks his own OpenWork to use it and it
   works for him too, labeled "Shared by Laurent".
4. I open the dashboard library and see mine, Ben sees "shared with me", and
   the org catalogs sit untouched in Catalogs.
