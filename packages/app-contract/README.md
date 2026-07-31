# @openwork/app-contract

The public contract for OpenWork Apps: the `openwork.app.json` manifest
standard, the permission vocabulary, contribution types, capability schemas,
the installed-app lifecycle model, and the canonical validator.

Everything in OpenWork that decides whether an app may be installed, what it
may do, and where it may appear reads this package. The CLI, CI, the server
preview, the installer, and the update path all call the same
`validateManifest`, so a manifest cannot be accepted in one place and rejected
in another.

## The manifest

An app declares itself in a root `openwork.app.json`:

```json
{
  "manifest_version": 1,
  "id": "com.example.notes",
  "name": "Notes",
  "description": "Keeps a scratch note beside your work.",
  "version": "1.0.0",
  "publisher": { "name": "Example Labs" },
  "repository": "https://github.com/example/notes",
  "license": "MIT",
  "icons": { "default": "assets/icon.svg" },
  "engines": {
    "openwork": { "min": "0.1.0" },
    "app_api": { "min": "1.0.0", "max_exclusive": "2.0.0" }
  },
  "platforms": [{ "os": "darwin", "arch": ["arm64", "x64"] }],
  "distribution": {
    "type": "github-release",
    "repository": "https://github.com/example/notes",
    "asset": "notes-{version}.owapp"
  },
  "entrypoints": { "surfaces": { "main": "dist/index.html" } },
  "contributions": [
    {
      "type": "surface",
      "id": "main",
      "entrypoint": "main",
      "presentation": "panel",
      "default_size": { "width": 360, "height": 480 }
    },
    {
      "type": "right_sidebar_item",
      "id": "notes-rail",
      "label": "Notes",
      "surface": "main",
      "icon": "assets/icon.svg"
    }
  ],
  "permissions": [
    { "id": "storage.app", "reason": "Keep your notes between sessions.", "quota_bytes": 1048576 }
  ],
  "privacy": {
    "summary": "Notes stay on this machine.",
    "data_handled": ["none"],
    "retention": { "policy": "persistent", "description": "Until you delete the app data." }
  },
  "update": { "channel": "github-release", "rollback_supported": true }
}
```

Validate it with `openwork-app validate openwork.app.json` from
[`@openwork/app-tools`](../app-tools).

### Design rules worth knowing before you write one

**App ids are reverse-DNS and must contain a dot.** Built-in OpenWork extension
ids never contain a dot, so an installed app structurally cannot shadow one.

**Unknown fields are rejected.** A misspelled permission key fails the manifest
instead of silently dropping the declaration.

**Duplicate JSON keys are rejected.** A document where a linter reads one
permission set and the installer reads another is refused outright.

**Compatibility is a window, not a range expression.** `{ "min": "1.0.0",
"max_exclusive": "2.0.0" }` means `1.0.0 <= version < 2.0.0`. There is no
range grammar to mis-parse.

**Disclosure and enforcement must agree.** If `privacy.third_parties` names a
host, `network.host` must permit it. If you request `audio.microphone`,
`privacy.data_handled` must say `microphone-audio`. The validator refuses a
manifest that promises less than it asks for.

**Contribution ids are unique across every type.** The host registers them as
`<appId>/<contributionId>`, so a command and a shortcut cannot share an id.

**Every shipped entrypoint must be reachable.** An entrypoint no contribution
references is an undeclared executable surface, and is rejected.

## Permissions

| Permission | Risk | Consent | Grants |
|---|---|---|---|
| `audio.microphone` | critical | enable | Microphone capture, only with a visible listening state |
| `openwork.connect.read` | critical | enable | Read-only Connect queries, limited to declared scopes |
| `runtime.background.continuous` | high | enable | A background runtime that keeps running |
| `openwork.threads.start` | high | use | Start an OpenWork thread, per user gesture |
| `network.host` | high | install | Network access to exactly the listed hostnames |
| `ai.realtime` | moderate | enable | A host-minted, short-lived realtime credential |
| `ai.inference.transient` | moderate | install | Structured one-shot inference |
| `desktop.floatingSurface` | moderate | enable | A host-owned floating window |
| `openwork.attachments.create` | moderate | use | Attach a document to a thread, per user gesture |
| `desktop.globalShortcut` | low | low | Register the named global shortcuts |
| `storage.app` | low | install | App-scoped key/value storage within a quota |

Consent stages are separate on purpose. `install` is recorded at trust review,
`enable` is confirmed when the runtime first starts, and `use` additionally
requires a fresh host-issued gesture token for every single call. Installing an
app never starts its microphone.

### What an app cannot request

There is no vocabulary for shell execution, arbitrary filesystem access, Node,
native binaries, accessibility or screen capture, reading raw environment
values or provider credentials, arbitrary MCP execution, arbitrary IPC, or
arbitrary OpenWork server routes. These are absent rather than gated: an app
cannot request what cannot be spelled.

Apps are told whether a required environment variable is *configured*. They
never receive its value.

## Trust model

v1 provenance is a GitHub release binding plus content hashing: the package
records the repository, release tag, and immutable commit it was built from,
and every file is hashed and closed over by the package metadata.

This is **not** a publisher signature. It does not attest who produced the
bytes. The manifest reserves room for signing and transparency later without a
v1 break, and nothing in OpenWork presents a checksum as cryptographic
publisher identity.

## JSON Schema

`schema/openwork.app.schema.json` and `schema/openwork-package.schema.json` are
generated from the same Zod schemas the validator uses, by `pnpm schema`. They
cannot drift from the validator, because they are the validator.
