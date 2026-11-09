# Blob format (draft v1)

A blob is one JSON file. It may hold the whole org or any set of area keys. The same format is used for export, upload, the "before" snapshot and revert.

## Envelope

```jsonc
{
  "$schema": "https://openworklabs.com/schemas/config-blob/v1.json",
  "format": "openwork.config-blob",
  "formatVersion": 1,

  "exportedAt": "2026-11-09T18:00:00Z",
  "source": {
    "deployment": "cloud",              // cloud | self_hosted
    "instanceId": "ins_…",              // stable per Den install
    "appVersion": "0.19.2",
    "organization": { "id": "org_01h…", "slug": "acme", "name": "Acme" }
  },

  "scope": ["ai-gateway.providers", "members.teams"],   // what this blob owns; see below
  "baseHash": "sha256:…",              // hash of the source org's config, over the whole scope, at export

  "areas": {
    "members": {
      "teams": { "items": [ /* items */ ] }
    },
    "ai-gateway": {
      "providers": { "items": [ /* items */ ] }
    }
  },

  "secrets": [ /* index of every $secret placeholder, for the input step and for scripts */ ]
}
```

### `scope`

- `scope` lists the area keys this blob **owns**. Only those areas are diffed. In `mirror` mode, only those areas can lose items.
- An area *in* `scope` with `"items": []` means "this area should be empty". That only causes deletes in `mirror` mode.
- An area *not* in `scope` is never touched, even if the blob refers to it (references are resolved, not written).
- A whole-org export lists every exportable key.

## Items

```jsonc
{
  "id": "ipr_01h8x…",                    // source TypeID. Matching tier 1; reused on create if free
  "key": "anthropic-prod",               // optional. externalKey where the resource has one
  "name": "Anthropic (prod)",            // display name. Never an identity on its own
  "rev": "sha256:…",                     // hash of the normalized spec, name and key at export time (three-way base)

  "spec": {                              // the portable, editable part. One schema per area, versioned
    "providerId": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "models": [ { "id": "ipm_…", "modelId": "claude-sonnet-4", "enabled": true } ],
    "access": {
      "orgWide": false,
      "teams": [ { "$ref": "members.teams/tem_01h…", "name": "Platform" } ]
    },
    "credentials": {
      "apiKey": { "$secret": "ai-gateway.providers/ipr_01h8x…/credentials.apiKey", "set": true }
    }
  }
}
```

**Rules:**

- `spec` is produced by an **allowlist serializer** per area. It never contains:
  - database IDs of runtime rows
  - timestamps
  - `createdBy` / `updatedBy`
  - derived or cached fields
  - secrets
- Child rows (models, entries) are nested inside the parent and carry their own `id` so they can be matched too.
- Unknown fields on upload are an error (strict schema), so typos don't get dropped silently.
- `rev` and `id` may be removed by someone writing a blob by hand. The item is then matched by the lower tiers and treated as having no base (two-way diff).

## Identity

There are three ways to identify an item, used in this order (details in [mapping.md](./mapping.md)):

1. **`id`**: the TypeID. It's globally unique (UUIDv7), so it means the same thing on any instance.
   - **When a create on import can reuse the source `id`, it does**, if that ID isn't taken anywhere on the target. Cloud → self-hosted → cloud then round-trips with identical IDs and every later import matches exactly.
   - If the ID is taken (for example, the blob is imported into a *second* org on the same instance, which is a clone), we create a new ID and write an **alias** row: `config_blob_alias(org_id, area, source_instance_id, source_id → local_id)`. This plays the role of Terraform state.
2. **`key`**: user-chosen and stable (`^[a-z0-9][a-z0-9._-]{0,127}$`, the existing `externalKey` rule). Today only teams, BYOK providers, MCP connections, desktop policies and marketplaces have one. Proposal: add `external_key` to every exportable root resource over time. It is optional, and makes hand-written blobs easy.
3. **Natural key**: declared per area (e.g. team name, MCP URL, permission set `default_key`). Used only when it is **unique on both sides**.

`name` is for people. On its own it's only ever used to *propose* a match.

## References

```json
{ "$ref": "<area>/<id or key>", "name": "<hint, ignored on import>" }
```

- A reference to an item **in the same blob** resolves to whatever that item maps to.
- A reference to an area **not in the blob** is looked up on the target: `id` → alias → `key` → unique natural key → proposed match.
- People are referenced by email: `{ "$ref": "people/ada@example.com" }`. They resolve to target members, or to planned creates/invitations when `members.people` is in the blob. Otherwise a missing person is *unresolved*: invite them, or drop them from the grant.
- Free-text references in the current schema (e.g. `org_default_model.provider_id` = `openwork` | `lpr_…` | `ipr_…`) are turned into proper `$ref`s by the adapter.

## Secrets

```json
{ "$secret": "<stable path>", "set": true }
```

- Exported for every secret field, whether or not a value is stored. `set` tells the importer whether the source had one.
- Paths are stable, so a blob edited and uploaded again keeps its placeholders (as Auth0 does with `AUTH0_PRESERVE_KEYWORDS`).
- Ways to fill a placeholder on upload:

| Form | Meaning |
|---|---|
| `{ "$secret": "…", "keep": true }` | keep the target's current value (only if the item matched and has a value) |
| `{ "$secret": "…", "env": "ANTHROPIC_KEY" }` | resolved on the server from an environment variable. Self-hosted only, behind an operator allowlist |
| `{ "$secret": "…", "value": "sk-…" }` | **only accepted through the inputs endpoint or UI**, never stored inside the blob (see [change-requests.md](./change-requests.md#secret-inputs)) |
| `{ "$secret": "…", "unset": true }` | create without it. The item is marked "needs setup" in the UI |

- Secrets are never in the diff text. The plan shows only `secret: will keep / will set / missing`.
- Whole encrypted JSON blobs that mix config and secrets (`sso_provider.oidc_config`) are split by the adapter: non-secret fields go in `spec`, secret fields become placeholders.

## Hashes

- `rev` = `sha256(canonicalJson({ spec without $secret values, name, key }))` (`itemRev`); areas whose names are derived (people) leave the name out. A rename on the target after export is therefore a change there, and a rename only in the blob is an edit. Canonical JSON: sorted keys; arrays in a defined order per field (ordered lists stay ordered, sets are sorted by id).
- `baseHash` = hash over the sorted `(area, id, rev)` of everything in `scope` at export.
- On the target we compute the same values from the current state. That lets us run the three-way diff and detect drift (see [mapping.md](./mapping.md#three-way-diff)).

## Versioning

- `formatVersion` is for the envelope. Each area has its own `specVersion` in the registry.
- Importers accept old area versions through per-area upgrade functions (like the Drizzle snapshot upgraders). They refuse newer versions they don't know, unless the admin forces it and the unknown fields are listed.
- `source.appVersion` far ahead of the target is a warning on the plan, not a hard error.

## Size and storage

- Inline JSON in the request (limit about 5 MB), at most 2,000 items per area and 20,000 in all. Specs may nest at most 32 levels, and the keys `__proto__`, `constructor` and `prototype` are refused anywhere in `areas`. Large content later (brand asset bytes, big skill payloads) may move to a `.zip` holding `blob.json` + `assets/`.
- On the server, uploaded blobs are stored **encrypted** (`encryptedMediumTextColumn`). They are org configuration, even without secrets.
