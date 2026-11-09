# Config blobs (internal name)

- **Feature key (proposed):** `configBlobs`, declared in `packages/features/src/registry.ts`. Cloud and self-hosted, off by default.
- **Author:** @OmarMcAdam
- **Status:** being built (phases 0–3, see [plan.md](./plan.md)).
- **Turning it off:** hides Settings › Config and answers 404 on `/v1/config-blobs/*`. Change requests already applied stay applied; queued ones wait and resume when it's on again.

## What it is

Config blobs let an admin export all or part of an organization's configuration as JSON, edit it, and import it again. Imports can go into the same org or another one, on the same instance or a different one (cloud → self-hosted and back).

An import never writes straight to the database. It becomes a **change request**: it is diffed against the org as it is now, its items are mapped, it is reviewed and then applied. The model is a mix of Drizzle's `generate` (diff snapshots, ask about ambiguous renames) and PlanetScale deploy requests (review, approval, a serial deploy queue, a revert window).

```
 export ──► blob.json ──► (edit) ──► upload (UI or API with a config token)
                                          │
                                          ▼
                              change request (queued, returns id)
                                          │
                     analyze: match items, diff, check references and secrets
                                          │
                 ┌────────────────────────┴───────────────────────┐
         needs mapping / needs input                           ready
     (admin confirms proposed matches,                           │
      supplies secrets)                                          │
                 └──────────────────────► approve ──► apply queue ──► applied
                                                                 (snapshot kept for revert)
```

## Documents

| File | Contents |
|---|---|
| [research.md](./research.md) | How Drizzle, PlanetScale, Terraform, Kubernetes, Directus, Auth0, Grafana and Hasura handle this, and what we take from each |
| [inventory.md](./inventory.md) | The Den sidebar mapped to blob keys, the tables behind each key, secrets, and what is left out |
| [format.md](./format.md) | The blob file format: envelope, item identity, references, secrets, hashes |
| [mapping.md](./mapping.md) | How the diff and matching work: match tiers, change states, conflicts, collisions |
| [change-requests.md](./change-requests.md) | Queue lifecycle, API, config token, UI, apply and revert |
| [plan.md](./plan.md) | Phased build plan, guard rails, tests, decisions |

## Main decisions proposed

1. **Every item carries its ID and a portable key.** An import tries to keep the source TypeID when that ID is free on the target, so cloud and self-hosted refer to the same item by the same ID. When it can't (for example, cloning an org on the same instance), we record an alias. Re-imports then match exactly, with no guessing. See [format.md](./format.md#identity).
2. **Match in tiers, and never pick for the user when two items are equally good.** The order is: ID, then alias, then `externalKey`, then a natural key that is unique on both sides. Anything else is a *proposed* match the admin must confirm, Drizzle-style. Same-name collisions are always shown to the admin. See [mapping.md](./mapping.md).
3. **Three-way diff.** Each exported item carries a revision hash. On import we compare *what you downloaded*, *what is there now* and *what you uploaded*. That way we can tell your edits apart from changes someone else made in the meantime. This is like PlanetScale's three-way merge and the Kubernetes last-applied annotation.
4. **Credentials are never exported; content is** (skills and prompts included, with a warning). **People are carried** by email; missing people become invitations.
5. **Secrets become placeholders.** Credential columns become `$secret` placeholders that say whether a value is set. On import each one is resolved: keep the current value, enter a new one, read it from an environment variable (self-hosted), or leave it unset so the item is created but needs setup.
6. **Merge by default; deleting is opt-in.** A missing area or item means "leave it alone". Deletes happen only in `mirror` mode, within the blob's scope, and each one is listed for confirmation.
7. **Applying reuses the existing services, not raw table writes.** Validation, permissions, audit logging and side effects stay the same as in the UI. Each config area is an *adapter* in one registry. A CI check makes every org-scoped table either exported or explicitly excluded.
8. **Every apply first saves a "before" blob of its scope.** A revert is just another change request made from that blob.
