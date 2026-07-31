# OpenWork Apps

OpenWork Apps make OpenWork hackable. Anyone can publish an application to a
public GitHub repository, and anyone can install it by pasting that URL — with
the same review, sandboxing, and lifecycle guarantees whoever wrote it.

This document is for people writing one. For the manifest field reference see
[`packages/app-contract/README.md`](../packages/app-contract/README.md); for the
packaging tools see [`packages/app-tools/README.md`](../packages/app-tools/README.md).

The reference application is
[different-ai/openwork-station](https://github.com/different-ai/openwork-station).
It is a genuine third-party consumer of everything described here: it imports
nothing from this repository and uses no monorepo path aliases.

## Extensions and Apps

**Extension** is the umbrella. OpenWork already had extensions — built-ins like
Voice Mode and Computer Use, Claude plugin bundles, OpenCode plugins, MCP
directory entries — described by the manifest model in
`apps/app/src/app/extensions.ts`.

**App** is the new *executable* extension kind. It ships code that runs, so it is
the kind that needs a package format, a sandbox, and a permission model. Adding
Apps did not replace the extension model; it added a source adapter to it. Every
existing extension keeps working exactly as before.

## What an app is

A public GitHub repository with `openwork.app.json` at its root and a `.owapp`
package attached to a release. That is the whole contract.

```
openwork.app.json      the manifest, at the repository root
dist/                  your built bundles
assets/                icons
```

The manifest declares an id, a version, what the app contributes to the
interface, what permissions it wants and why, what environment variables it
needs, and what it does with your data.

## Writing one

```bash
openwork-app validate openwork.app.json
```

Then build, package, and publish:

```bash
openwork-app pack \
  --root ./staging \
  --out dist/my-app-1.0.0.owapp \
  --repository https://github.com/me/my-app \
  --tag v1.0.0 \
  --commit "$(git rev-parse HEAD)"
```

Attach both the `.owapp` and the generated `.sha256` to a GitHub release whose
tag matches. OpenWork reads the manifest **at the commit that tag resolves to**,
finds the asset your manifest names, downloads it, and verifies it.

Pack from a staging directory containing only what ships. Packing your working
tree puts your source, tests, and lockfile inside every user's install — see
Station's `scripts/package.mjs` for the pattern.

## What the user sees before anything is installed

Preview executes none of your code. OpenWork reads metadata, reads your manifest
at the resolved commit, downloads your package, and verifies it. There is no
clone, no build, no package-manager hook, and no way for a manifest to name a
command to run.

The review screen shows your app's identity, publisher, repository, release tag,
**immutable commit**, licence, package digest, permissions grouped
critical-first with *your stated reason for each*, environment requirements,
what your privacy block says, and any warnings.

Write those reasons for a person deciding whether to trust you. "Transcribe what
you say while listening is switched on" is a reason. "Required for
functionality" is not.

## Permissions

| Permission | Risk | Consent | Grants |
|---|---|---|---|
| `audio.microphone` | critical | enable | Microphone capture, only with a visible listening state |
| `openwork.connect.read` | critical | enable | Read-only Connect queries, limited to declared scopes |
| `runtime.background.continuous` | high | enable | A background runtime that keeps running |
| `openwork.threads.start` | high | **use** | Start an OpenWork thread |
| `network.host` | high | install | Exactly the listed hostnames — no wildcards |
| `ai.realtime` | moderate | enable | A host-minted, short-lived realtime credential |
| `ai.inference.transient` | moderate | install | Structured one-shot inference |
| `desktop.floatingSurface` | moderate | enable | A host-owned floating window |
| `openwork.attachments.create` | moderate | **use** | Attach a document to a thread |
| `desktop.globalShortcut` | low | enable | Register the named global shortcuts |
| `storage.app` | low | install | App-scoped storage within a quota |

The three consent stages are independent. `install` is recorded at trust review.
`enable` is confirmed when the runtime first starts. **`use` additionally
requires a fresh, single-use gesture token for every single call** — the host
mints one on real user input and it expires in seconds. Your app cannot start a
thread on its own, however confident it is.

Apps install **disabled**. Setup and enablement are separate user actions.
Installing an app never starts its microphone.

### What you cannot ask for

There is no vocabulary for shell execution, arbitrary filesystem access, Node,
native binaries, accessibility or screen capture, reading raw environment values
or provider credentials, arbitrary MCP execution, arbitrary IPC, or arbitrary
OpenWork server routes. These are absent rather than gated: you cannot request
what cannot be spelled.

### Secrets

Declare the environment variables you need by name. OpenWork stores them in the
same user-level store Voice Mode uses, with atomic writes and restrictive
permissions, and tells your app **whether each is configured** — never the
value.

For AI access, request `ai.realtime` or `ai.inference.transient` and let the host
mint a short-lived credential. An app that wants to read `OPENAI_API_KEY` has
misunderstood the model.

## The runtime

Your surfaces run in a sandboxed renderer: `sandbox: true`,
`contextIsolation: true`, no Node integration in any form, a per-app session
partition, and a `default-src 'none'` Content-Security-Policy.

Network access is enforced at the session level against exactly the hosts your
`network.host` permission names. Exact match only — `evil-api.openai.com` does
not satisfy a permission for `api.openai.com`.

The host owns window creation, always-on-top behaviour, geometry, display
selection, and safe-area clamping. You declare a preset and a size you would
like; the host decides where it actually goes, so an app can never park a
floating window off-screen or over system UI.

Your only host surface is `window.openwork`, exposing `request` and `on`.
`ipcRenderer` is never exposed in any wrapped form, and there is no channel
parameter.

## Lifecycle

Preview → trust review → install (disabled) → setup → enable → run → disable →
update → rollback → repair → uninstall.

An update that **adds a permission, or widens one you already granted**, is
downloaded and verified but withheld until the user reviews the difference.
Removals and narrowings apply immediately. No permission is ever silently
expanded.

Rollback restores the previous verified package, which is retained on disk — it
is a real rollback, not a re-download of something that may no longer exist. It
leaves the app stopped, because resuming automatically would restart whatever
went wrong.

Repeated crashes in a short window quarantine the app. Uninstall asks whether to
keep the app's data and records which the user chose.

Disable, uninstall, quarantine, and permission revocation all take effect the
same way: the app stops appearing in the runtime plan, and the supervisor tears
down its background runtime, microphone access, in-flight requests, shortcuts,
surfaces, sidebar contributions, and outstanding gesture tokens.

## Trust model, stated plainly

v1 provenance is a **GitHub release binding plus content hashing**. The package
records the repository, release tag, and immutable commit it was built from, and
every file is hashed and closed over by the package metadata: an extra file
smuggled into the archive and a missing file are both detected.

**It is not a publisher signature.** It does not attest who produced the bytes.
The manifest reserves room for signing and transparency without a v1 break, and
nothing in OpenWork presents a checksum as cryptographic publisher identity —
the CLI and the trust screen both say so in their own words.

### Time-of-check to time-of-use

Preview resolves a mutable ref to an immutable commit, downloads the package,
hashes it, and pins every input into a short-lived single-use candidate. Install
consumes that candidate and those exact bytes; it re-resolves nothing.

If a release is swapped between review and install, the user gets what they
reviewed. A replayed or expired candidate is a distinct, reported failure.

## Compatibility policy

**Manifest version.** `manifest_version: 1` is the current standard. A version
this host does not support fails with one clear message rather than a list of
field errors. A new manifest version will only be introduced for a change that
cannot be made additively.

**App API version.** Declared as a window: `{ "min": "1.0.0", "max_exclusive":
"2.0.0" }`. Additive capabilities raise the minor; a removed or changed
capability raises the major. Declare a `max_exclusive` at the next major so a
future host does not run your app against a contract it was not written for.

**Engine range.** `engines.openwork` is the same shape against OpenWork's own
version. There is no npm-style range grammar to mis-parse: the failure mode of a
mis-parsed range is installing an app the host cannot run.

**Permission additions.** New permissions are additive. An existing app never
gains one, because a permission not in an installed app's approved set is denied
regardless of what a newer manifest says.

**Deprecation.** A deprecated capability keeps working for at least one major App
API version and reports a warning at validation time before it is removed.

**Package format.** `package_format_version: 1`. A change to the archive layout
raises it, and hosts refuse a format version they do not implement rather than
guessing.

## Testing your app

The parts that need a microphone, a model, or a connected source should get real
evidence. Everything else — ranking, state transitions, budgets, staleness,
privacy rules — should be pure and tested without any of them. Station splits on
exactly that line: `src/core` is covered by tests that need no network, no
microphone, and no host.

Do not present fixture coverage as equivalent to a live run.
