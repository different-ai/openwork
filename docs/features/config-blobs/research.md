# Research: how other tools export, diff, match and apply config

Sources are linked inline. Points marked *(unverified)* come from general knowledge, not a page I read.

## Summary: do they include an ID for each item?

**Yes, but usually a portable one, not the database key.**

| Tool | Identity in the file | Database / instance ID in the file? | Same-name handling |
|---|---|---|---|
| Kubernetes | `metadata.name`, unique per kind and namespace | No. `metadata.uid` is assigned by the server and never written in manifests | Names are unique by construction |
| Grafana | dashboard `uid`, chosen by the user | No. The numeric `id` is removed on export | Docs warn: never reuse a title in a folder or a uid in an instance |
| Terraform | resource address (`aws_instance.web`) | Kept in **state**, not in config. `import {id, to}` adopts an existing object; `moved {from, to}` records a rename | Addresses are unique by construction |
| Auth0 Deploy CLI | name / `identifier` / composite (`client_id+audience`) | Removed by default (`AUTH0_EXPORT_IDENTIFIERS=false`) | Duplicate names behave unpredictably; a known problem |
| Directus | natural keys (`collection`, `collection.field`) | Only on relations | Rename = delete + create |
| Hasura | natural keys (source, table, role) | No | Replaces all metadata; no item matching |
| Drizzle Kit | table / column names; each snapshot has `id` + `prevId` | Snapshot IDs only | Asks: "created or renamed from …?" |

The pattern: a **stable, portable identifier** that you can read, separate from the instance-local primary key, plus a display name that is free to change. Identity across instances is either a user-chosen key (k8s, Grafana, Auth0) or a mapping kept on the side (Terraform state).

**How this applies to us.** Our primary keys are TypeIDs: `<prefix>_<UUIDv7>`. They are globally unique, unlike auto-increment IDs, so they can carry across instances. We already have user-chosen keys for five resources (`external_key`: teams, LLM providers, MCP connections, desktop policies, marketplaces). We need both:

- the ID, so an exact round trip works with no guessing;
- the key or name, so a person can read and edit the file;
- something like Terraform state (an alias table) for the case where the ID can't be reused.

## Drizzle Kit

Docs: https://orm.drizzle.team/docs/drizzle-kit-generate, https://orm.drizzle.team/docs/drizzle-kit-push. Source: `drizzle-kit/src/cli/views.ts`, `snapshotsDiffer.ts`.

- **How it works.** `generate` serializes the schema into a JSON snapshot, diffs it against the previous snapshot, asks about ambiguities, then writes SQL plus the new snapshot. `push` diffs against the live database instead.
- **Snapshot chain.** Snapshots have `id` and `prevId`. Two snapshots with the same `prevId` are reported as a *collision* (two branches made from the same base).
- **Renames.** Snapshots record renames in `_meta`, so a rename is not seen again as drop + create next time.
- **Ambiguous matches.** For each kind (schemas → enums → tables → columns), when there are both *created* and *deleted* items, Drizzle asks about each new item: `+ create` or `~ rename from <old>`. It offers every unclaimed deleted item. Once an old item is chosen, it is no longer offered (1:1 matching). Deleted items left over become drops, with data-loss warnings. **It does no fuzzy scoring; a person decides.**
- **Previews.** `--explain` (dry run), `--force` (accept data loss), `tablesFilter` / `schemaFilter` (scoping).

**What we take:** a diff over normalized snapshots; resolve kinds in dependency order; for leftovers, a "create or same as X?" prompt with 1:1 matching; save the decisions so they aren't asked again.

## PlanetScale deploy requests

Docs: https://planetscale.com/docs/vitess/schema-changes/deploy-requests, https://planetscale.com/docs/vitess/schema-changes/safe-migrations, https://planetscale.com/blog/database-branching-three-way-merge-schema-changes

- **Safe migrations.** Changes made directly on a protected branch are rejected. A deploy request is the only path.
- **Lifecycle:**
  1. **Open.** Checks for lint, data loss and conflicts with production run.
  2. **Review / approve.** Approval can be required.
  3. **Queue.** Serial, first in first out, with one extra parallel lane for changes that don't overlap.
  4. **Deploy.** Optionally *gated*: it waits for a manual "apply".
  5. **Complete.**
  6. **Revert.** There is a 30-minute window.
- **Approval is dismissed if the change changes after approval.** A request already in the queue is removed and must be approved again.
- **Three-way merge against the base.** A request is validated against all queued changes when it is submitted, so conflicts show up early. The same change made in two branches is allowed ("overlap").
- **Partial failure.** You can retry only the failed parts, or cancel.

**What we take:** the lifecycle and statuses, approval invalidation, check on enqueue *and* just before apply, one apply at a time per org, revert window, gated apply.

## Directus schema snapshot / diff / apply (closest API design)

Docs: https://directus.io/docs/api/schema. Source: `api/src/utils/schema/validate-diff.ts`, `get-versioned-hash.ts`.

- **Three endpoints.** `GET /schema/snapshot` returns the snapshot, `POST /schema/diff` returns `{hash, diff}`, and `POST /schema/apply` takes `{hash, diff}`.
- **Hash.** The hash covers the target's **full** current schema plus the Directus version. On apply the server recomputes it. If it differs, the apply is refused with a specific per-item reason ("trying to create X but it already exists") or a general "generate a new diff". `?force=true` overrides.
- **Version and vendor.** A mismatched Directus version or database vendor is refused unless forced.
- **Partial scope.** `includeCollections` / `excludeCollections` limit the snapshot and diff. Apply leaves everything out of scope alone.
- **Modes.** `mode=merge` only adds and updates; `mirror` also deletes.

**What we take:** separate diff and apply calls tied together by a base hash; scoped diffs; merge vs mirror; per-item conflict reasons; version check.

## Auth0 Deploy CLI

Docs: https://github.com/auth0/auth0-deploy-cli/tree/master/docs

- **Identity.** IDs are removed on export by default. Resources are matched by per-type identifier lists (name, `identifier`, composite keys), because tenant IDs differ.
- **Secrets.** Secret values are replaced with `##KEYWORD##` placeholders.
  - `AUTH0_KEYWORD_REPLACE_MAPPINGS` fills them on import: `@@KEY@@` for JSON values, `##KEY##` for literal strings.
  - `AUTH0_PRESERVE_KEYWORDS` keeps placeholders on re-export.
  - `AUTH0_IGNORE_DRY_RUN_FIELDS` keeps secrets out of the dry-run diff.
- **Delete safety.**
  - An *omitted* resource type is skipped.
  - An *excluded* one (`AUTH0_EXCLUDED`, `AUTH0_INCLUDED_ONLY`, or per-name exclusions) is ignored both ways.
  - An *empty list* means delete everything of that type, but only when `AUTH0_ALLOW_DELETE=true` (default false).

**What we take:** named secret placeholders that survive an edit; "omitted ≠ empty"; deletes off by default; secrets kept out of diff noise.

## Terraform

Docs: https://developer.hashicorp.com/terraform/language/block/moved, https://developer.hashicorp.com/terraform/language/import, https://developer.hashicorp.com/terraform/cli/commands/plan

- **Identity.** Config uses addresses; **state** maps each address to the real ID. That's our alias table.
- **Renames and adoption.** `moved` records renames; `import` adopts existing objects instead of creating duplicates. Both are user-declared mappings that are saved.
- **Plan / apply.** Always a plan first. `-target` limits scope (and pulls in dependencies), but the docs discourage it.
- **Secrets.** `sensitive = true` hides values in output, but they are still in state and in saved plans. A known pitfall: don't keep secrets in the change request after use.

## Kubernetes

Docs: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/, https://kubernetes.io/docs/reference/using-api/server-side-apply/, https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/

- **Identity.** Kind + namespace + name. `uid` comes from the server.
- **Three-way merge.** Client-side apply uses the `last-applied-configuration` annotation: (last applied, live, new). That tells "I removed this field" apart from "someone else added it".
- **Field ownership.** Server-side apply tracks who owns each field. Changing a field another manager owns is a **conflict**, resolved by force, giving up the field, or matching its value.
- **Lost updates.** `resourceVersion` prevents them (optimistic concurrency).
- **Pruning.** `--prune` deletes objects not in the applied set, limited to an allowlist of kinds.

**What we take:** three-way diff per item using a revision captured at export; per-item conflicts rather than all-or-nothing; pruning limited to an explicit scope.

## Grafana provisioning

Docs: https://grafana.com/docs/grafana/latest/administration/provisioning/

- **Identity.** Portable `uid` for dashboards; the instance `id` is removed on export. Data sources match by `name` + `orgId`, with an optional `uid`.
- **Versions.** Data sources have a `version`. Provisioning won't overwrite a newer version in the database.
- **Secrets.** `secureJsonData` is encrypted at rest. Files can use `$ENV` / `${ENV}`.

## Hasura metadata *(partly unverified)*

Docs: https://hasura.io/docs/2.0/migrations-metadata-seeds/manage-metadata/

- **No partial apply.** It replaces all metadata ("There is no way to create an export of partial Metadata"). A counter-example: we need partial blobs.
- **Inconsistent items.** References to missing objects are marked *inconsistent* rather than failing everything. We do the same for unresolved references.
- **Secrets** *(unverified)*: referenced by env var name (`from_env`).

## Lessons for our design

1. Export the **TypeID** *and* a readable key/name. Keep IDs when importing where possible. Keep an alias table for the rest (Terraform state).
2. Match in tiers: ID → alias → user key → unique natural key → **proposed** match the admin confirms → create. 1:1 only. Never pick between equally good candidates.
3. Save confirmed decisions (alias rows, like `moved` blocks) so the same blob never asks twice.
4. Put a revision hash on every item and a base hash on the blob. Do a three-way diff per item. Check again on enqueue and right before apply. Refuse or ask on drift; allow an explicit force.
5. Never export secrets. Use named placeholders that survive editing. Fill them on import from a typed value, an environment variable or the existing value.
6. Missing means "don't touch". Deletes only in `mirror` mode, limited to the blob's scope, each one listed.
7. Show a plan per item (`+` / `~` / `-`) before anything is applied. Diff, review, approve, queue, apply. Invalidate approval if the plan changes.
8. Apply in dependency order. Unresolved references are per item (*blocked*), not fatal to the whole request.
9. Save a "before" snapshot for revert.
