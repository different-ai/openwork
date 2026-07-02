# Memory Bank — Architecture (v0)

> Status: **Draft for scoping.** Pre-spec architecture doc that feeds
> `/officeHours` → `/specToProvenPR`. Decisions captured in an interview on
> 2026-07-02 and revised after a 5-lens `/autoplan` review the same day.
> **[VERIFY]** = confirm at impl; **[DECISION]** = locked; **[FIX]** = correction
> applied after the autoplan review (see §13 for the review trail).

---

## 1. Goal & principles

A per-user **memory bank** inside OpenWork. The user opts in by chatting (e.g.
"save this memory to the memory bank"); the agent drafts a memory + relevant context,
a human verifies it, and it's persisted **server-side**. Later the user can **explicitly
search** their memories with natural-language phrasing, and **view/delete** them from a
lightweight desktop panel.

Principles (priority order):

1. **Durable interface, evolvable implementation.** The long-lived contract is the
   REST/MCP **tool shape**; storage + search behind it are swappable (lexical today,
   vector/entity-graph later) with no contract change.
2. **No new infrastructure dependencies.** MySQL (PlanetScale) + Drizzle only.
3. **Harness-agnostic.** Memory is a shared knowledge layer keyed to the **principal**.
4. **Server-side storage, thin client.**
5. **Human-verified writes.** Persist human-confirmed content, never raw agent output.

Note on recall (revised): v0 is **explicit, lexical** search — the user must ask. We do
**not** claim semantic/"understands meaning" recall, and we do **not** auto-recall. The
honest value bar is "saved facts are retrievable across sessions on a natural-language
query," not "the agent never makes you re-explain."

---

## 2. Surface & the durable contract

Memory is exposed as **den-api REST routes**, auto-surfaced as capabilities through the
existing meta-MCP (`/mcp/agent`). That rail exposes exactly two tools —
`search_capabilities` and `execute_capability` — so memory is **reached by executing a
discovered capability, not by a bespoke `memory_save` tool.** **[FIX B1]**

```
harness ── search_capabilities("save a memory")   → finds capability "postMemory"
        └─ execute_capability({ name: "postMemory", body: {...} })

harness ── search_capabilities("search my memories") → finds "getMemorySearch"
        └─ execute_capability({ name: "getMemorySearch", query: { q, limit } })
```

### Routes & operationIds [FIX — corrected]
`buildOperationId` (`ee/apps/den-api/src/openapi.ts:16-38`) strips `v1` and PascalCases
path segments. The **actual** operationIds / MCP tool names are:

| Route | operationId / tool name | scope |
|---|---|---|
| `POST /v1/memory` | `postMemory` | `mcp:write` |
| `GET /v1/memory/search` | `getMemorySearch` | `mcp:read` |
| `GET /v1/memory` (list) | `getMemory` | `mcp:read` |
| `DELETE /v1/memory/:id` | `deleteMemoryById` | `mcp:write` |

Verified: none collide with `BLOCKED_OPERATION_IDS`, all stay ≤49 chars after
`structuralShorten`, and the two GETs are distinct paths (no collision). **Never** refer
to `memory_save`/`memory_search` in the prompt or docs — those names do not exist.

### v0 CRUD scope [DECISION]
save + search + **list + delete** (list + delete back the desktop management panel).
Owner-scoped everywhere (§8). `PATCH` (edit) and a `bankScope` param are future.

### Catalog inclusion [DECISION: new "Memory" tag]
Add `"Memory"` to `SAFE_INCLUDED_TAGS` (`ee/apps/den-api/src/mcp/policy.ts:2-23`) and
tag the routes `tags: ["Memory"]`. This is the only mechanism in active use (`x-mcp:true`
is dormant). Route pattern to mirror for *structure*: `routes/workers/core.ts` — **but
its authorization is org-scoped; memory must be user-scoped (see §8, [FIX B4]).**

---

## 3. Data model (MySQL / Drizzle)

```
memory
  id           typeid("memory")   PK
  user_id      typeid("user")     -- owner (v0 always set)
  org_id       typeid("organization")
  scope        enum('user','org') default 'user'   -- two-bank model; v0 forces 'user'
  content      text               -- HUMAN-VERIFIED memory (plaintext in v0, see §8)
  source       varchar            -- server-set: 'chat' | 'modal'
  tags         json               -- optional
  created_at, updated_at (shared `timestamps`)
  indexes: (user_id)
  FULLTEXT index on (content)      -- raw SQL; created idempotently, see below

memory_context
  id           typeid("memctx")   PK
  memory_id    typeid("memory")   FK → memory.id  (ON DELETE CASCADE)
  citation     json               -- { conversation_id?, message_id? }  (all optional)
  snippet      text               -- plaintext in v0
  origin       enum('active_conversation','searched_conversation')
  created_at
  indexes: (memory_id)
```

### [FIX B5] Register the typeid prefixes
`memory` and `memctx` must be added to `idTypesMapNameToPrefix`
(`packages/utils/.../typeid.ts`) or `denTypeIdColumn`/`denTypeIdSchema` won't compile.
This is a cross-package edit and is part of the schema task, not an afterthought.

### [DECISION] Two-bank model, personal-only in v0
`scope` present from day one, **hard-enforced to `'user'` server-side** — not merely a
column default. A client can POST `scope:'org'`; the handler must overwrite it. Every
read filters `user_id = principal.userId` **and** (defensively) `scope='user'` so a
future org row can never retroactively leak into personal reads. [FIX]

### On-device provenance
`memory_context` captures agent-gathered citations + snippets. All citation fields are
**optional** (floor: a `snippet` with no ids). **[VERIFY]** which ids the agent can read
on-device.

### Search backend [DECISION: MySQL FULLTEXT] + [FIX B2]
PlanetScale/Vitess supports `FULLTEXT` + `MATCH … AGAINST`. v0 uses **NATURAL LANGUAGE
MODE**, owner-scoped, relevance-ranked.
- **Fresh-install hazard:** new DBs bootstrap via `drizzle-kit push` (which cannot see a
  raw `FULLTEXT` index — Drizzle mysql-core has no FULLTEXT DSL,
  [drizzle-orm#1495](https://github.com/drizzle-team/drizzle-orm/issues/1495)) and
  baseline marks migrations applied-without-executing — so a plain migration-only index
  is **silently absent in production** while working on incrementally-migrated dev DBs.
  **[FIX B2]** Create the index **idempotently on a path both bootstrap and migrate
  hit** — e.g. a startup/bootstrap step that checks `information_schema.STATISTICS` for
  the index and runs `CREATE FULLTEXT INDEX` if missing. Add a CI/startup assertion that
  the index exists.
- **Query safety [FIX]:** bind the query (`MATCH(content) AGAINST(${q} IN NATURAL
  LANGUAGE MODE)` via Drizzle's `sql` template) — **never** `sql.raw`; combine the MATCH
  with the `user_id` predicate in a single `and(...)`. (Precedent: `admin-tools.ts` binds
  correctly.)
- **PlanetScale caveat [VERIFY]:** `innodb_ft_min_token_size` (default 3) and stopwords
  are **not tunable** on PlanetScale — short/common query terms silently won't match.
  The v0 mitigation is honest scoping (§1), not "tune it." If recall is weak, consider
  also indexing `snippet` or a denormalized column (future).

---

## 4. Save flow (human-verified)

Trigger: *"save this memory to the memory bank."*

1. **Draft (standalone turn).** Agent composes candidate `content` + optional context.
2. **Human verification.** Human confirms/edits before persisting. Baseline = chat-driven
   confirm (harness-agnostic); optional desktop modal (deferred, §9).
3. **Persist** — `POST /v1/memory`. **[FIX B3] Flattened, mostly-optional payload** so the
   agent (which only sees `hasBody:true`, not the schema) can construct it. The shape is
   also encoded in the route's OpenAPI `summary` (the one body hint the agent gets):
   ```jsonc
   {
     "content": "User deploys via den-worker-proxy into a Daytona sandbox", // required
     "tags": ["deploy", "infra"],                                            // optional
     "contexts": [                                                           // optional
       { "snippet": "…excerpt…",                                             // required if present
         "conversation_id": "…", "message_id": "…",                          // optional
         "origin": "active_conversation" }                                   // optional
     ]
   }
   ```
   - Server **sets `source`** and **ignores/overwrites client `scope`** (forces `'user'`).
   - Server wraps the `memory` + N `memory_context` inserts in **one transaction** (no
     orphaned context rows). [FIX]
   - **Input bounds [FIX]:** cap `content` length and `contexts` count (cheap abuse guard;
     full rate-limiting/quota deferred, §9).
4. **Feedback.** The save must surface an explicit success/failure signal (see §6 states).

---

## 5. Retrieval flow (explicit, lexical)

**[DECISION] Explicit search only** — no auto-recall.

1. User asks in natural language: *"what was that deal with Acme?"*
2. Agent calls `getMemorySearch` (`GET /v1/memory/search?q=…&limit=…`). `limit` defaults
   to 20, capped; results relevance-ranked via `MATCH … AGAINST`, owner-scoped.
3. **No match → empty result set, HTTP 200** (not an error) so the agent reports "nothing
   found" gracefully. [FIX]
4. Agent does best-effort set reduction and presents results.

Response (stable): `{ results: [{ id, content, tags, created_at, score, contexts? }] }`.

---

## 6. Desktop client (thin) + gating

### [DECISION] Client self-serve toggle, UI-gate only; v0 metrics are qualitative
- New Preferences-tab toggle via `useLocal()` `featureFlags.memory` (mirror
  `feature-flags-preferences.ts`). **Client-only, per-device, never synced.**
- Gates **UI visibility only** (soft gate): reveals the management panel, copy-prompt
  button, and optional modal. Routes stay callable (owner-scoped + authz'd).
- **[DECISION] Metrics are qualitative in v0.** The client-only flag is not
  server-observable, so we do **not** commit to server-computed adoption/recall metrics;
  we measure via manual eval + raw save/search counts (see product.md). A server enable
  event + hard gate are deferred (§7, §9).

### Management panel (list + delete) — states are the product [FIX design]
The panel and save flow must specify non-happy-path states, **reusing the desktop's
existing accessible Base UI primitives** (Switch, Dialog/AlertDialog, `ConfirmModal`,
`Empty`, Sonner `toast`) rather than building from scratch:
- Save: draft-loading, success (toast), failure/retry, offline, cancel/discard.
- Panel: loading, **enabled-but-empty** (first-run payoff — use `Empty`), error, offline.
- Delete: **optimistic delete + undo toast** (resolves the "reversible-feeling vs
  permanent" tension); focus moves sensibly after removal.
- Recall: the agent renders results (prompt-owned), but the panel must not imply a search
  UI it doesn't have.
- **Accessibility:** icon-button names, destructive-action focus, `aria-live`/toast
  announcements — mandated via the primitives.
- **Content is rendered escaped** in the panel (stored-XSS guard; §8). [FIX]

### Agent priming [DECISION: static `## Memory Bank`, search-first]
Append a static, distinct `## Memory Bank` section to `OPENWORK_AGENT_PROMPT`
(`apps/server/src/openwork-runtime-config.ts:34-66`) — separate from the existing
`## Memory` (credential-hygiene) section. It must **[FIX B1]**:
- Be **search-first**: "to save a memory, search for a capability to save a memory, then
  execute it" — never name `memory_save`.
- Cover save (draft → human-confirm → execute `postMemory`) and retrieval (search →
  reduce → present).
- **[DECISION, plaintext risk]** Instruct the agent to **not persist secrets,
  credentials, tokens, or sensitive PII** — this prompt guidance is the *only* v0
  mitigation for plaintext-at-rest (§8).
- The copy-prompt button primes non-server harnesses (Claude Code, local opencode); on
  desktop server workspaces the prompt is already injected, so the button is a secondary
  cross-tool utility, not the first-run path.

---

## 7. Hard gate (deferred fast-follow) [DECISION: deferred]

v0 gate is client-only + UI-only. A hard, server-enforced gate (server per-user pref or
org `desktop-policies`, in-handler `403`, optional conditional prompt injection, and a
kill switch) is scoped but **not built**. Additive — no contract change.

---

## 8. Auth, scoping & security (v0)

- Principal always carries `userId` + `organizationId` (`mcp/auth.ts:19-24`); routes read
  `c.get("user").id` / `c.get("activeOrganizationId")`. Live session + membership checks
  already gate every request (revocation is immediate — verified).
- **[FIX B4] Owner-scoping (the #1 risk).** Do **not** copy the org-scoped worker
  accessor. Memory reads/list/delete filter on **`user_id = principal.userId`** as the
  primary predicate. Add a dedicated `getMemoryByIdForUser`; return **404** (non-leaking)
  for ids the caller doesn't own; add a **cross-user access regression test as a merge
  gate.**
- `DELETE` **hard-deletes** the FK'd `memory_context` rows (ON DELETE CASCADE / explicit)
  for right-to-be-forgotten.
- **[DECISION — plaintext at rest, risk accepted]** `content`/`snippet` are plaintext in
  v0. The repo ships `encryptedTextColumn` but v0 does **not** use it. Mitigation is
  prompt guidance (§6) telling the agent not to store secrets. **This is a documented,
  accepted v0 risk; encryption at rest is a pre-GA requirement (§9).**
- Query is parameterized + owner-filtered (§3). Panel escapes content (§6).
- **Deferred (§9):** per-user quota / rate-limiting (storage-exhaustion DoS). v0 keeps
  only cheap input bounds (§4).

---

## 9. Out of scope for v0 (explicitly deferred)

- Vector DB / embeddings / semantic recall.
- **Encryption at rest** for content/snippet — **pre-GA requirement**, accepted risk in v0.
- Auto-recall / passive session-start recall (considered, cut).
- Cross-tool entity/relationship synthesis.
- Active org-shared bank (schema-ready, not activated).
- Hard server-enforced gate + server-side metrics + kill switch.
- Per-user quota / rate-limiting (only cheap input bounds in v0).
- **Memory reaping on account/org deletion** — there is no DB FK or offboarding hook, so deleting
  a user/org does not remove their `memory`/`memory_context` rows. A cleanup hook is a pre-GA
  requirement alongside encryption at rest (§8); v0 relies on the explicit `deleteMemoryById`.
- `PATCH` (edit a saved memory) — v0 is view + delete only.
- Optional desktop save/verify modal (chat-driven is the v0 baseline).

---

## 10. Durability / evolution path

| Concern | v0 | Future (no contract change) |
|---|---|---|
| Search | MySQL `FULLTEXT` (NL mode), owner-scoped | vector/embedding or hybrid ranker |
| Privacy | plaintext + prompt guidance | encryption at rest (pre-GA) |
| Context | `memory_context` citations + snippets | entity/relationship synthesis |
| Banks | `scope='user'` enforced | activate `scope='org'` |
| Gate | client toggle, UI-only, qualitative metrics | server pref / `403` / events / kill switch |
| Recall | explicit lexical | passive + semantic |

---

## 11. Decisions resolved + items to verify

Resolved (this doc):
- **Tool access** → search-first via `execute_capability`; real names `postMemory` /
  `getMemorySearch` / `getMemory` / `deleteMemoryById` (§2). [FIX B1]
- **FULLTEXT bootstrap** → idempotent index creation on bootstrap+migrate path (§3). [FIX B2]
- **Save payload** → flattened, mostly-optional, shape in OpenAPI summary (§4). [FIX B3]
- **Owner-scoping** → `user_id`-primary, 404 non-owned, regression-test gate (§8). [FIX B4]
- **typeids** → register `memory`/`memctx` in `packages/utils` (§3). [FIX B5]
- **Encrypt-at-rest** → plaintext v0, prompt-guidance mitigation, pre-GA requirement (§8).
- **Gate/metrics** → client-only, qualitative metrics; hard gate deferred (§6, §7).
- **Recall** → explicit lexical only; honest value bar; no `≥60%` metric (§1, §5).
- **Search backend / tag / two-bank / citation / CRUD** → as prior (§2, §3).

Verify at impl (non-blocking):
1. **[VERIFY]** On-device citation id availability (§3).
2. **[VERIFY]** PlanetScale `innodb_ft_min_token_size`/stopword impact on recall (§3).

---

## 12. Handoff

- **Next:** `/specToProvenPR` for staged, proven PRs.
- **Suggested PR staging:**
  1. **den-db:** `memory` + `memory_context` tables + migration; **register typeids
     (`packages/utils`)**; **idempotent `FULLTEXT` index on the bootstrap+migrate path**;
     `ON DELETE CASCADE`.
  2. **den-api:** routes `postMemory`, `getMemorySearch` (bound `MATCH…AGAINST`, NL mode,
     empty-set on no match), `getMemory` (list), `deleteMemoryById` — **all
     `user_id`-owner-scoped, 404 non-owned, force `scope='user'`, one-tx save, input
     bounds**; **structured save/search/delete events**; new `"Memory"` tag; OpenAPI
     `summary` encodes the save body shape; **cross-user regression test (merge gate).**
  3. **eval:** `memory-save-recall.flow.mjs` (mirror `mcp-search-capabilities.flow.mjs`)
     proving save→recall end-to-end.
  4. **apps/server:** static **search-first** `## Memory Bank` prompt incl. no-secrets
     guidance.
  5. **Desktop:** `featureFlags.memory` toggle + management panel (list + delete, all
     states via Base UI, optimistic-delete + undo, escaped content) + copy-prompt button.
  6. **Fast-follow (deferred):** hard gate, encryption at rest, rate-limit/quota, modal.
- **Per-PR verification gate (`AGENTS.md`) — applies to every stage above.** Each stage's
  PR must: (a) **run tests with pnpm and report the exact commands + results** in the PR
  body; (b) produce **`fraimz` proof** for every experience-affecting change —
  `evals/results/<run-id>/fraimz.html` via `/fraimz` (or `pnpm fraimz --flow <id>`), each
  frame binding claim → user action → observable assertion → validated screenshot, and
  report `Passed` **only** when `fraimz.html` exists with observable assertions (else
  `Incomplete`/`Failed` with repro); backend-only/types-only stages may skip but must say
  so and prove the core flow is unchanged; (c) attach **end-to-end evidence** (short video
  preferred, screenshots otherwise) of save → recall → view/delete; (d) meet coding
  guidelines (no `any`/`as`, pnpm, `@/components`/shadcn Base UI, smallest diff). See
  `TASKS.md` TASK-11.
- **Reference files:** `ee/packages/den-db/src/schema/workers.ts`,
  `ee/apps/den-api/src/routes/workers/core.ts` (structure only — re-scope authz to user),
  `ee/apps/den-api/src/openapi.ts` (operationId gen),
  `ee/apps/den-api/src/mcp/policy.ts:2-23`, `search.ts` / `agent.ts` (rail + error shape),
  `apps/server/src/openwork-runtime-config.ts:34-66`,
  `apps/app/src/react-app/domains/settings/state/feature-flags-preferences.ts`,
  `apps/app/src/react-app/kernel/local-provider.tsx`, `evals/flows/*cloud-mcp*.flow.mjs`.

---

## 13. Review trail

Revised after a 5-lens `/autoplan` review (product · arch · design · devex · security),
2026-07-02. Full findings + consolidated report:
`~/.agentic-workflow/joi-fairshare-openwork/plans/20260702-112912-memory-bank/consolidated-review.md`.
Blockers B1–B5 and the operationId correction are folded in above; the three product/
security tensions were decided as recorded in §11.
