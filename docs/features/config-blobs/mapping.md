# Diff and mapping

Analysis turns an uploaded blob into a **plan**: a list of item operations, each with a state, a field diff and any problems that block it. The admin confirms the plan before it can be applied.

## Steps

```
1. Validate      schema, formatVersion, area specVersions, scope, size, permissions
2. Snapshot      export the target's current state for the blob's scope (same serializer as export)
3. Match         pair blob items with target items, area by area in dependency order
4. Resolve refs  turn every $ref into a target item (or a planned create)
5. Diff          classify each pair; field-level diff; three-way check against rev
6. Secrets       list the placeholders that need input
7. Plan          ordered operations + blocking issues + plan hash
8. Preflight     each area checks its planned writes against the target (reads only);
                 skips and blocks feed a second build of the plan (change-requests.md › Preflight)
```

**Dependency order** comes from the adapter registry (each area declares the areas it references), sorted topologically. For example: `members.teams` → `members.roles` → `connectors.oauth-clients` → `connectors.mcp` → `ai-gateway.providers` → `desktop-policies` → `plugins.*` → `settings.advanced.collections`.

Child rows (provider models, limit entries, permission entries) are matched **inside** their matched parent using the same tiers. This is the order Drizzle uses: tables, then columns.

## Match tiers

For each area: candidates are the blob items and the target items in scope. Pairing is **one-to-one**. Once an item is matched it leaves both pools.

| Tier | Rule | Automatic? |
|---|---|---|
| 1. ID | `item.id` equals a target item's id | yes |
| 2. Alias | `config_blob_alias(org, area, source.instanceId, item.id)` points to a target item | yes |
| 3. Saved decision | an earlier confirmed mapping for this blob lineage, same source item | yes |
| 4. Key | `item.key` equals the target's `external_key` | yes |
| 5. Natural key | the area's declared natural key matches, **and it's unique on both sides** | yes, shown as "matched by name/URL" so people can see it |
| 6. Proposed | similarity score above a threshold, see below | **no: needs confirmation** |
| 7. None | — | becomes *create* (blob side) or *untouched / delete* (target side, depending on mode) |

**What tiers 1 to 5 are:** checks for being the same item, never guesses. **Tier 6 only produces suggestions.**

**When tiers disagree** (the ID matches item A, but the key matches item B), the item is marked `conflict.identity` and must be confirmed. We never pick one ourselves.

### Proposed matches (tier 6)

For each unmatched blob item, score every unmatched target item of the same area:

- name similarity (normalized: case, spaces, punctuation; token Jaccard + edit distance)
- natural-key fields that are equal but **not unique** (e.g. two providers with `providerId=anthropic`)
- spec overlap (share of equal leaf fields), especially strong fields (URL, upstream provider, model IDs)

The UI shows, for each unmatched blob item, Drizzle-style:

```
"Anthropic (prod)"  is new, or is it the same as…
   ( ) + create new item
   (•) ~ "Anthropic production"   92%  same base URL, 14/15 models equal
   ( ) ~ "Anthropic (staging)"    61%  same base URL
```

- When there are more than 50,000 (unmatched blob item × unmatched target item) pairs in an area, no scores are computed: every unmatched blob item is `needs_mapping` with "too many items to suggest matches; choose manually".
- Suggestions are sorted by score; the best one is preselected **only** if it's clearly ahead (e.g. at least 0.85 and 0.15 ahead of the next). Otherwise "create" is preselected, plus a warning.
- Confirmed choices are saved on the change request. When it's applied, they become alias rows, so the next import of the same lineage matches at tier 2 or 3.
- An area may score pairs itself (`similarity`). People do: a person is their email, so someone at another address is proposed as the same person only when the part before the @ is the same (an organization that changed domains) or the names are. Sharing a role or teams says nothing about who someone is, and would ask the question about every person a file brings.

### Same-name collisions

| Situation | Result |
|---|---|
| Two blob items with the same `id` or `key` in one area | validation error; the upload is rejected |
| Two blob items with the same name | allowed (plugins and skills allow it). Each is matched on its own; name is never the only matcher |
| A natural key that isn't unique on the target | tier 5 is skipped for that value and the item goes to tier 6 with every candidate listed |
| Creating would break a unique constraint on the target (e.g. `team.name`) | blocking issue `collision.unique`. Options: rename the new item, match it to the existing one, or skip it |

## Change states

Each item pair gets exactly one **state** and may have several **flags**.

| State | When |
|---|---|
| `create` | blob item, no match |
| `update` | matched, spec differs |
| `rename` | matched, only `name` / `key` differ (shown separately because it's low risk) |
| `unchanged` | matched, the hashes are equal |
| `delete` | target item in scope, no match, `mirror` mode, and the admin has ticked it |
| `untouched` | target item in scope, no match, `merge` mode |
| `skip` | the admin excluded the item, or its area is unsupported on this deployment (e.g. `ai-gateway.openwork-models` on self-hosted), or the target owns it elsewhere (SCIM-managed people and teams) |

| Flag | Meaning | Blocks apply? |
|---|---|---|
| `needs_mapping` | tier 6 or an identity conflict not yet confirmed | yes |
| `needs_input` | a `$secret` the source had a value for (or that doesn't say), with no keep / env / value / unset decision. One the source never had (`set: false`) defaults to keep, or to unset where the target has none | yes |
| `ref_unresolved` | a `$ref` with no target. Options: map it, create it (if it's in the blob), or drop the reference (see References for what a drop removes) | yes |
| `blocked` | the write is known to fail here: the item's spec is invalid, or its area's preflight says so, with what to do | yes |
| `drift` | the target changed since export (see below) | yes, until acknowledged |
| `collision.unique` | the create or rename would break a unique constraint | yes |
| `destructive` | delete, removing access, removing models, lowering limits | no, but needs an extra confirmation |
| `external_effect` | apply calls out (MCP probe, OAuth discovery) | no (shown) |
| `unsupported_field` | the field doesn't exist on this version or deployment | no (dropped, shown) |

## Three-way diff

For a matched item we have three versions:

- **base**: `item.rev`, what the uploader downloaded
- **ours**: `item.spec`, what they uploaded
- **theirs**: the target's current spec and its hash `current`

| Comparison | Meaning | Result |
|---|---|---|
| `current == rev` | nobody changed it since export | normal two-way diff (ours vs theirs) |
| `current != rev` and `ours == base` (the uploader didn't edit this item) | someone else changed it | **`untouched` by default**. We don't revert other people's work just because an old copy was uploaded. The admin can force "overwrite with blob" |
| `current != rev` and `ours != base` | both sides changed it | `drift`. A field-level three-way merge: fields changed on only one side merge automatically, fields changed on both are conflicts. The UI shows base / current / blob for each conflicting field |
| no `rev` (hand-written, or from another org) | no base | two-way diff; every difference is treated as intended |

To show field values from **base**, we need the base spec, not only its hash. When the source is this same org, we can keep the last N exports server-side, keyed by `baseHash` (cheap, encrypted). Otherwise the diff falls back to hash comparison: "changed since export" without per-field merging.

## Plan hash and approval

- `planHash` = hash of (the ordered operations + resolved decisions + the target `current` hashes they were computed against).
- Approval records `planHash`. **Any change** invalidates the approval: a new mapping decision, a new secret input, or a re-analysis that finds different target hashes. The same rule as PlanetScale.
- Right before apply, the worker recomputes the target hashes for every item in the plan. If any differ from the planned ones, the request goes to `stale`. It is analyzed again automatically and needs approval again. The admin can force an apply that has drifted only through the UI, item by item.

## References

- `$ref` targets that are planned creates in the same plan are resolved by ordering: the creator runs first, and the reference is rewritten to the new local ID during apply.
- Cross-area references to areas outside the blob are resolved read-only. They never become writes.
- People (`people/<email>`) resolve to members of the target org, or to planned creates/invitations from `members.people` in the same plan. If neither, the flag is `ref_unresolved` with two fixes: invite or drop from the grant. Invite adds a planned `members.people` create (pending invitation, role `member`, no teams) that runs first; the reference resolves to it.
- A chosen target for a reference must be one of the referenced area's current items; references into an area that can't be read here can't take a chosen target.
- **What the plan tells a client about a reference left to the admin.** Both are display only and outside `planHash`:
  - `refuses` on the reference lists the decisions the plan would refuse for it, so they are not offered: `invite` for a person the import leaves out on purpose, a handle that isn't an email, or an author who can't invite; `drop` where the item can't be imported without the reference. Absent when nothing is known to be refused.
  - `refTargets` on the plan lists, for each referenced area the file does not carry, the items already in the organization the reference can be pointed at (id and name). The items of an area the file carries are in the plan itself. A reader is sent only the areas they may view.
- In Den, the References step lists each missing thing once. One choice applies to every item that uses it; opening the row shows each use, which can be decided on its own.
- **What a drop removes.** By default only the reference's own key. Where an entry is nothing without what it names (an access grant and its person, a router's model and its provider, a limit's assignment and its team: the area's `requiredRefs`), dropping the reference removes the whole entry, in the plan and at apply. Where the reference is the item's own scope and sits in no list (the team of a team's settings, the team or provider a limit applies to), it can't be dropped: without it the item would apply to everyone. It stays `ref_unresolved` with "can't be dropped (this item can't be imported without it): choose one here, or skip the item".

## Delete modes

| Mode | Unmatched target items in scope |
|---|---|
| `merge` (default) | `untouched` |
| `mirror` | listed as `delete` with **every one unticked by default**. The admin ticks each one, or "select all" with a typed confirmation |

Out-of-scope items are never deleted. Neither are items the target org owns outside the config surface (personal library items, runtime data), whatever the mode.

## Example plan (API shape)

```jsonc
{
  "changeRequestId": "ccr_01h…",
  "planHash": "sha256:…",
  "summary": { "create": 3, "update": 5, "rename": 1, "delete": 0, "unchanged": 41, "blocking": 2 },
  "areas": [
    {
      "area": "ai-gateway.providers",
      "items": [
        {
          "op": "update",
          "blob": { "id": "ipr_A", "name": "Anthropic (prod)" },
          "target": { "id": "ipr_A", "name": "Anthropic (prod)" },
          "matchedBy": "id",
          "flags": ["needs_input"],
          "fields": [
            { "path": "models[claude-opus-4].enabled", "from": false, "to": true },
            { "path": "access.teams", "added": ["Platform"], "removed": [] }
          ],
          "secrets": [ { "path": "credentials.apiKey", "decision": null, "targetHasValue": true } ]
        },
        {
          "op": "create",
          "blob": { "id": "ipr_B", "name": "OpenAI" },
          "matchedBy": null,
          "flags": ["needs_mapping"],
          "candidates": [ { "id": "ipr_X", "name": "OpenAI (old)", "score": 0.78, "reasons": ["same base URL"] } ]
        }
      ]
    }
  ]
}
```
