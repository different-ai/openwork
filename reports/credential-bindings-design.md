# Per-principal credential bindings: concrete design

Companion to `reports/llm-gateway-credential-abstraction.md`. That doc argued
blocks-first; this one designs the blocks against the actual codebase.

## The decisive finding

OpenWork already ships this exact pattern for MCP connections:

- `ExternalMcpConnectionTable.credential_mode` — `"shared" | "per_member"`,
  default `shared`
  (`ee/packages/den-db/src/schema/sharables/capability-credentials.ts:209`).
- Per-member credentials in `ConnectedAccountTable`, unique on
  `(orgMembershipId, providerId)` (`capability-credentials.ts:69-110`).
- One resolution branch at execution time: per-member row, else shared row,
  else a typed actionable error
  (`ee/apps/den-api/src/mcp/external-capabilities.ts:1179-1208`).
- Readiness vocabulary: shared-unconfigured → `needs_admin_setup`;
  per-member-unconnected → `needs_signin`
  (`routes/org/plugin-system/store.ts:2404-2423`).
- Lifecycle: member removal deletes their credential rows inside the removal
  transaction (`ee/apps/den-api/src/orgs.ts:~1997`), connection identity change
  purges member rows, health failures stamp `credentialHealth` with an action
  owner.

The schema comment on `ConnectedAccountTable` even names our gap explicitly:
"Unlike LLM provider keys (legitimately org-shared), a connected account's
credential belongs to one human's grant." The LLM building blocks are a port of
this proven pattern, not an invention.

## Block 1 — schema

### `llm_provider.credential_mode`

```
credential_mode ENUM("shared","per_member") NOT NULL DEFAULT "shared"
```

`shared` keeps today's behavior byte-for-byte: one encrypted org `apiKey`,
returned to granted members via `/connect`. Existing rows migrate untouched.

### `llm_provider_member_credential` (new table)

Modeled on `ConnectedAccountTable`, minus the OAuth machinery (no PKCE, no
refresh tokens, no issuer review — a pasted or provisioned API key is one
member-scoped write, not a redirect dance):

```
id                      lpc_* typeid PK
organization_id         indexed
llm_provider_id         FK → llm_provider
org_membership_id       FK → member
secret                  encryptedTextColumn        -- scalar key or env map
external_principal_id   varchar NULL               -- e.g. LiteLLM user_id
external_credential_id  varchar NULL               -- e.g. key alias/hash
state                   ENUM("active","blocked","stale","error") DEFAULT active
credential_health       JSON NULL                  -- {status, reason, checkedAt}
version                 int NOT NULL DEFAULT 1
created_by              ENUM("member","admin","provisioner")
created_at / updated_at
UNIQUE (org_membership_id, llm_provider_id)
```

Deliberately vendor-neutral: `external_*` columns are opaque strings any
provisioner can use; no `litellm_*` columns ever.

Considered and rejected: reusing `ConnectedAccountTable` directly. It is
provider-agnostic in principle, but its columns are OAuth-shaped
(`refreshToken`, `pendingCodeVerifier`, `scopes`, `externalAccountId`) and the
MCP domain enforces the inverted invariant (`per_member` requires OAuth). A
dedicated table keeps both domains honest.

### Not in scope for v1

`per_team` credentials. Overlapping team membership needs an explicit
precedence rule before it can exist; shipping member-level first covers the
known enterprise ask and avoids silently picking a key by database ordering.

## Block 2 — APIs

| Route | Guard | Behavior |
| --- | --- | --- |
| `PUT /v1/llm-providers/:id/my-credential` | `orgMemberRoute()`, granted members only, 400 `not_per_member` on shared providers | Member pastes their own key. Write-only: response is state, never the secret. |
| `DELETE /v1/llm-providers/:id/my-credential` | same | Mirror of MCP `disconnect-my-account` (`routes/org/mcp-connections.ts:2732-2767`). |
| `GET /v1/llm-providers/:id/member-credentials` | admin | Binding states for every granted member: `missing / active / blocked / stale / error`, external IDs, versions. **No secrets.** Powers the admin table and provisioner reconciliation. |
| `PUT /v1/llm-providers/:id/member-credentials/:memberId` | admin or service token | Upsert on behalf of a member (bulk import, provisioner). Accepts `secret`, `externalPrincipalId`, `externalCredentialId`, `expectedVersion` for optimistic concurrency. |
| `POST /v1/llm-providers/:id/member-credentials/:memberId/block` | admin or service token | Sets `state=blocked` without deleting; used by offboarding recipes that must revoke upstream first. |
| `GET /v1/llm-providers/:id/connect` | existing route | Gains the resolution branch (Block 3). |

Secret hygiene rules ported from the MCP routes:

- Secret fields are write-only optional replacements, never echoed
  (`mcp-connections.ts:2323` doc pattern).
- The secret-returning `/connect` route is excluded from MCP exposure
  (`x-mcp:false`) — this also fixes the existing shared-key leak through agent
  transcripts.
- Write-only binding routes may stay MCP-visible for `mcp:write` admins, since
  responses are redacted; that is what lets a workflow-based provisioner run
  through Connect without a bespoke API client.

## Block 3 — resolution

In `GET /v1/llm-providers/:id/connect`
(`ee/apps/den-api/src/routes/org/llm-providers.ts:701-782` today):

```
if provider.credentialMode == "per_member":
    binding = memberCredential(callerMembershipId, providerId)
    if binding == null or binding.state != "active":
        return 409 { error: "needs_key", action: link to member key page }
    return binding.secret
else:
    return provider.apiKey   # unchanged
```

Two consumers change with it:

- **Desktop sync** (`apps/server/src/cloud-provider-sync.ts`) already calls
  `/connect` with the member's own token, so per-member resolution is free; it
  only needs to treat `needs_key` as a surfaced state ("Add your key") instead
  of a silent skip, deep-linking to Den Web like `memberConnectLinks` does for
  MCP.
- **Hosted worker materialization**
  (`ee/apps/den-api/src/llm/cloud-provider-materialization.ts:141-180`) must
  resolve through the creating member's grants and bindings — this is the same
  phase-0 scoping fix the first report demanded, now with a concrete resolution
  function to call.

Plus the standing phase-0 rule: deliver auth keyed by runtime provider ID
(`lpr_*`), never flattened by env-var name, so two members' bindings can never
collide.

## Block 4 — membership lifecycle events

Provisioners must react to joins/leaves without polling domain tables. Today
there is no outbox, no webhooks, and team routes emit nothing. What exists:

- An in-process hook registry already fires on member add/remove and drives the
  OpenWork inference per-member key lifecycle
  (`ee/apps/den-api/src/organization-member-hooks.ts`,
  `inference.ts:288-314`).
- Outbox-shaped retry columns exist in `ScimSyncEventTable`, and a monotonic
  poll-cursor pattern exists in `AutomationRunnerNotificationTable`.

Cheapest honest design:

1. **Widen the hook union** to
   `member.invited | member.added | member.removed | team.created |
   team.deleted | team.member.added | team.member.removed` and call it at every
   mutation site. Three sites are currently uncovered and must be closed:
   JIT/bootstrap insert (`orgs.ts:~562`), team PATCH full-replace (needs an
   old-vs-new member diff, `routes/org/teams.ts:183`), and SCIM group
   attach/detach (`scim-groups.ts`).
2. **Persist a `membership_event` outbox row inside the mutation transaction**
   (org-scoped, autoincrement cursor, JSON payload). In-process hooks alone are
   not honest for external consumers — they vanish on crash or deploy.
3. **Expose `GET /v1/membership-events?after=<cursor>`** for v1. Signed
   webhooks can come later; a cursor API is enough for a scheduled reconcile
   recipe and avoids building subscription CRUD, signing, and dead-lettering
   now.

This block is independently valuable: SCIM-adjacent integrations, seat
billing, and audit tooling want the same feed.

## Block 5 — UI states (vendor-neutral)

Admin, Den Web `Models > Bring Your Own Keys`:

- Credential mode selector on the provider (`Shared key` / `Each member brings
  their own`).
- Per-member table fed by `GET .../member-credentials`: state chip
  (`missing / active / blocked / stale / error`), external ID, last verified,
  bulk CSV import, "copy invite link".

Member, Den Web "Your Connections" (same surface MCP per-member uses,
`ee/apps/den-web/app/(den)/dashboard/your-connections/`):

- Row per per-member provider: "Add your key" → paste dialog →
  `PUT my-credential` → optional live probe via the existing
  `POST /v1/llm-providers/test-connection`.

Desktop:

- Per-member provider without a binding renders a "Needs your key" card
  deep-linking to that page — the same interaction contract as MCP
  `needs_signin`, so members learn one pattern.

All of this is generic; a LiteLLM-provisioned key and a member-pasted OpenAI
key render identically.

## The LiteLLM reference recipe (zero core vendor code)

Packaged as a maintained workflow/skill plus docs. The LiteLLM master key
lives in the customer's secret store or the workflow's connection — never in
`llm_provider`.

Setup (admin, once):

1. Create the provider: base URL, models, `credential_mode: per_member`.
2. Grant teams/members access as usual (`llm_provider_access` is untouched).
3. Configure the recipe with the LiteLLM admin endpoint + master key, and a
   mapping OpenWork team → LiteLLM `team_id`.

Reconcile loop (scheduled Automation + event cursor):

```
events = GET /v1/membership-events?after=cursor
targets = GET /v1/llm-providers/:id/member-credentials

for member with grant and state=missing:
    user = LiteLLM /user/new or lookup            (user_id = opaque OpenWork member id)
    key  = LiteLLM /key/generate {user_id, team_id, models, max_budget, rpm/tpm}
    PUT member-credentials/:memberId {secret: key, externalPrincipalId, externalCredentialId}

for member.removed / team.member.removed events:
    LiteLLM /key/block (upstream first)
    POST member-credentials/:memberId/block
    later: LiteLLM /key/delete + DELETE binding

rotation (optional): LiteLLM /key/regenerate with grace period
    → PUT binding with new secret, version+1; desktops pick it up on next sync

drift check: LiteLLM /key/info vs binding external ids
    → mismatch marks credential_health = {status: "error", reason}
```

Ordering rule the recipe must honor and the API supports: **block upstream
before removing local materialization.** The `block` endpoint exists precisely
so offboarding is two safe steps instead of one racy delete.

Promotion criterion: if several customers run this recipe and ask for a
supported version with drift UI, wrap the same loop as a packaged adapter
behind the capability contract from the first report. Nothing about the schema
changes at that point — that is the test that the blocks were right.

## Sequencing

1. **Phase 0 (correctness, no schema):** worker grant scoping; auth by runtime
   provider ID; `x-mcp:false` on `/connect`.
2. **Phase 1a (blocks):** `credential_mode` + binding table + routes +
   resolution + desktop `needs_key` state + Den Web surfaces.
3. **Phase 1b (events):** hook-union widening + outbox + cursor API.
4. **Phase 2 (recipe):** LiteLLM workflow + docs; member-supplied CSV/paste
   flows already work without it.
5. **Phase 3 (optional):** packaged adapter, then OIDC/JWT federation for
   customers who want keyless.

## Verification plan (when implementation starts)

- `evals/specs` testkit spec: per-member binding CRUD + resolution — member A
  receives only A's key via `/connect`, member B without a binding gets
  `needs_key`, shared-mode providers unchanged.
- Spec: member removal emits `member.removed` event row and blocks the binding
  before grant cleanup.
- Existing `evals/specs/azure-byok-live.e2e.test.ts` pattern extended: desktop
  materializes a per-member provider with the member's own key under the
  `lpr_*` auth entry.

This document is design-only; no runtime behavior changed, so no test evidence
accompanies it.
