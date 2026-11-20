# Three-seat demo desktops

Operator-only launcher for **demo**, **practice**, and **backup** Daytona Linux
desktops. This is an infrastructure tool, not a new app feature or a replacement
for the workshop fleet. It does not create organizations, seed accounts, grant
models, sign anyone in, or copy credentials. Sign in separately in each desktop
to the same **dedicated sandbox organization**, never a production organization.

## Current state: blocked on a reviewed image

`snapshots.json` is deliberately empty. No clean demo image has been built,
audited, or pinned by this change. `plan` and `up` reject an absent review **before
loading live adapters, reading Daytona credentials, or dispatching a command**.
Do not populate the allowlist with invented IDs, an existing workshop image, an
unreviewed desktop, or a mutable image tag. There is no fallback image or automatic
build/provision path.

The launcher and failure paths have offline tests. The Daytona CLI/REST resource
schema, viewer authentication, Linux desktop, packaged app, and image helpers have
**not** been verified on a live sandbox in this change. No provisioning or remote
image building was authorized. A passing unit test is not a READY demo.

## Commands

Use Node 24.22.1 or newer within Node 24, and pnpm from the repository's
`packageManager`. Run from the checkout:

```sh
pnpm test:demo-desktops
pnpm demo:desktops --help
pnpm demo:desktops plan --snapshot demo-desktop-<reviewed-name>
```

Only after a separately authorized image build, audit, snapshot review and live
pilot, an authorized operator may run:

```sh
pnpm demo:desktops up --stage rehearsal-01 --snapshot demo-desktop-<reviewed-name>
pnpm demo:desktops refresh --stage rehearsal-01
pnpm demo:desktops down --stage rehearsal-01
```

`up` defaults to all three seats, 1440 minutes, `America/Los_Angeles`, and a $30
infrastructure estimate ceiling. A pilot can use `--seats practice --lifetime 60`.
The allowed seat names are fixed, with no duplicates. Lifetimes are 10–1440 minutes.
A stage is never reused or overwritten, including after cleanup. Use a new stage
name for the next run. `refresh` checks desktop/CDP and replaces short-lived viewer
links; it does **not** extend sandbox lifetime or sign a user in.

Live operations require an already-configured Daytona CLI and `DAYTONA_API_URL` /
`DAYTONA_API_KEY` for **the same dedicated team**. The launcher does not fetch,
discover, print, or install credentials. The REST snapshot metadata must match the
reviewed immutable ID, digest-pinned image reference, source sandbox, active state,
and exact 4 CPU / 8 GiB / reviewed disk size (10–40 GiB); otherwise no create runs.
Creation uses the pinned ID, not the reusable snapshot name, and passes the
provider-side `--ttl` at creation. It never passes `--public`, environment mounts,
or secret mounts. Created resources are checked again for identity, privacy and
size. CLI/REST schema drift fails closed; do not weaken checks to make a run pass.

The estimate uses 4 × $0.083/core-hour plus $0.0001/GiB-hour for snapshot disk,
multiplied by seats and maximum lifetime. It is **not a billing cap or current price
quote**: verify provider pricing before authorizing a run. It excludes image builds,
stored snapshots, model usage, backend services, taxes and all other charges.
`--budget-usd` deliberately changes only this local estimate gate.

## Private receipts and recovery

The only public command result is a directory, ready count and estimate (or action).
No signed viewer link is printed, returned as a world output, or written into the
checkout. Outputs live at:

```text
~/.openwork/demos/<stage>/<seat>/control.json
```

Directories must be caller-owned mode `0700`; receipts are atomically replaced
mode `0600`. Git checkout paths, symlink directories and loose permissions are
rejected. If `~/.openwork` already exists with different permissions, review its
ownership and contents before tightening permissions yourself. Bearer viewer URLs
are sensitive even with private permissions: do not attach receipts, logs, browser
profiles, or signed URLs to commits, PRs, screenshots or public evidence.

Each seat journals a random unique sandbox name before create and the resolved ID
immediately afterward. A partial/ambiguous failure attempts cleanup of **all**
journaled owners; no fan-out continues after a failed seat. `down` only acts on
those receipts and verifies private identity before deletion; it never scans or
deletes a fleet. Successfully stopped receipts no longer contain a viewer URL.
Permission, identity, missing-resource, auth and ambiguous delete failures remain
explicitly incomplete, rather than being treated as a successful cleanup.

A `.busy` directory serializes operations on a stage. If a controller is killed,
first confirm no process still owns the stage, inspect the private receipts and
provider state, then remove only the stale empty `.busy` directory and retry
`down`. Do not delete the journal before reconciling resources. A create timeout
can leave a sandbox finishing asynchronously: retry cleanup after creation has
settled. Provider TTL is the final backstop if the process or local journal is
lost; verify its actual behavior in the authorized live pilot. Snapshot storage
is not covered by sandbox TTL.

Viewer links expire at the lesser of one hour and the remaining lifetime. Before
publishing a link privately, the adapter requires private sandbox metadata, denied
unsigned HTTP, denied unsigned WebSocket and a successful signed noVNC HTTP/RFB
probe. Guest CDP remains loopback-only on port 9223; there is no CDP preview or
public port tunnel. `ready` means desktop/CDP/viewer checks passed, **not** that an
organization, account, connectors, models or a demo script are ready.

## Image work preserved, and exactly what remains

`worlds/lib/demo-desktop-files/` preserves the previous worker's **unfinished**
image ingredients:

- `install-tools.sh`: LibreOffice Impress/Calc, fonts and desktop automation tools.
- `package-sha.sh`: package a full pushed SHA in a clean Linux guest, then hash a
  deterministic tar stream of the packaged tree. This runs build/install hooks;
  review the source first and never run it with production credentials.
- `openwork.sh`, `app-control.sh`: isolated OpenWork state, loopback CDP and a
  serialized app start/restart helper.
- `chromium.sh`, desktop/MIME entries: separate employee/admin browser profiles
  and the OpenWork deep-link handler.
- `type-file.sh`, `demo-copy.sh`, `prompts.json`: type a fictional prompt into the
  focused app without a trailing newline/automatic submit.

These are not an image builder. They are not installed or executed by the launcher.
Before adding any real allowlist entry, a separately authorized follow-up must:

1. Select and pin a clean **x86_64 Linux desktop base by immutable ID/digest**,
   configure 4 CPU / 8 GiB / 10–40 GiB disk, and document noVNC/X11 startup, user,
   writable disk and provider TTL behavior. No base ID has been selected here.
2. Implement and test image assembly: install these helpers at `/home/daytona/demo`
   with executable permissions; install MIME/desktop files in the user's local
   applications directory; configure noVNC, X11 and the default browser. The current
   files assume user `daytona`, display `:99`, port 6080, and specific package paths.
3. Implement the **release Cloud package download and published digest verification**
   path for canonical `release:<version>/cloud`, or authorize a reviewed full pushed
   SHA build using the preserved script. Pin dependencies/toolchain, verify Node 24,
   verify the real packaging command/output, and record the packaged-tree SHA-256.
   No release installer, trusted digest receipt or completed SHA build exists here.
4. Implement a machine-verifiable clean-base audit and a signed-off review receipt.
   Require empty OpenWork/browser profiles, no sign-in/session tokens, API keys,
   cookies, keychains, copied config, build caches, command histories, private files,
   running authenticated apps or residual credential environment. Merely writing
   `demo-clean-base-v1: passed` is **not** an audit. The audit is not implemented here.
5. Stop/scrub the guest, create an immutable provider snapshot, wait for active state,
   and independently verify the REST metadata fields used by `verifyDemoSnapshot`.
   Confirm CLI snapshot-ID support and resource field names without bypassing gates.
6. Review a PR adding the actual snapshot entry, with a non-secret provenance/audit
   report and live pilot evidence. Schema per entry: `id` (immutable snapshot UUID),
   `image` (`registry/path@sha256:<64 hex>`), `sourceSandboxId` (UUID), canonical
   `source`, `packageSha256` (64 hex), `diskGiB` (integer 10–40), and `audit` (exact
   `demo-clean-base-v1: passed`). Keep sensitive build receipts outside Git.
7. Run one authorized private pilot: validate packaged app and deep-link sign-in,
   independent browser profiles, LibreOffice open/edit/save, fonts, copy helper,
   timezone, guest-only CDP, denied unsigned HTTP/WebSocket and signed viewer,
   refresh expiry, deliberate partial-failure cleanup, provider expiry, and no
   sensitive data in outputs. Only then authorize the three-seat launch.

Until these steps are complete, keep `snapshots.json` empty and this PR in draft.
