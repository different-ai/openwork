# OpenCode v2 and earlier chat history

OpenWork runs only OpenCode v2. Desktop packages and managed workers ship the
pinned `opencode2` executable; standalone servers retain its verified download
fallback. Earlier engine choices no longer change the runtime.

## Bringing over earlier chats

When local v1 history has not been copied, OpenWork requires **Import chats**
before continuing. The server blocks chat API access even if a client bypasses
the dialog. Existing snooze preferences do not bypass this upgrade.
The notice opens a consent dialog; copying starts only after its **Import chats**
button is selected. `POST /engine/v1-history/import` requires the host token and
explicit confirmation. `GET /engine/status` reports progress and the saved result.
Existing v2 chats are kept. Chats pause while copying; closing OpenWork preserves
progress, and startup resumes the interrupted copy before opening v2 history.
A successful receipt survives restart and dismisses the one-time offer. At startup,
OpenWork checks for v1 chats newer than that receipt and requires another copy
when someone returned to v1 during the preview.

The upgrade and progress dialogs cannot be dismissed until copying completes.
Errors keep chat access blocked and offer **Try again**. A failed initial status
read is retried so startup timing cannot hide the upgrade. Running v2 tasks
must finish before copying begins. Diagnostics use passive registration evidence;
they never query native MCP status, which can activate workspace connectors.

## What migration does

Migration requires the OpenWork host token and explicit confirmation. It takes
an immutable SQLite snapshot of the active profile's v1 database, including
committed WAL writes. The original database is never modified.

The copy has durable stages: snapshot, reversible payload externalization,
native conversion, payload restoration, and transactional transfer. Large JSON
strings are held in SQLite and replaced with unique references in the private
conversion workspace. The pinned native converter processes those references;
SQLite restores their exact values afterward, including inline files. No chat
is trimmed, and no whole-chat export or import body is allocated in JavaScript.

The v2 engine initializes its own schema and then closes before the transfer.
Managed engine leases and a pending-copy fence keep other managed app instances
from opening that database during an unfinished copy. Running v2 tasks prevent
the copy from starting. The original v1 data remains intact; v2 chats pause until completion.
The projected schemas must match before target writes begin.

Messages move in bounded row batches, including a single very large payload
without decoding it in JavaScript. Each batch commits its progress in the target
SQLite database. A killed worker rolls back its active transaction; retry or
restart resumes the retained workspace and committed batches. Conversion and
payload restoration have their own restart checkpoints. Errors never blacklist
a chat or mark a partial copy complete.

Existing v2 chats are skipped without changing their messages, metadata, order,
or event history. A new session and its migration checkpoint are created in one
transaction. Only that checkpoint lets the migration resume writing the session;
a matching session ID alone does not. New messages retain the native converter's
order, and event sequence allocation never rewinds.

Every original v1 message and part is also retained byte-for-byte in the target's
`openwork_v1_message` and `openwork_v1_part` archive tables, keyed by the snapshot's
SHA-256. Original session fields are retained in `openwork_v1_session`. This
preserves fields and older part types that the native v2 projection does not
represent. The archive is not a promise that v2 renders unsupported legacy items.
Source rows and projected message identities are verified before completion.
Only then is the staging workspace removed. Existing v2 history is backed up
before the transfer, and the two most recent backups remain on disk.

The saved snapshot time remains the migration cutoff after restart: chats
created in v1 after that snapshot still need a later copy. Completion/error
receipts remain visible after restart. The copy stays local to this profile;
it neither imports remote-server history nor merges later edits automatically.

OpenCode's conversion still resets session permissions and revert state and
normalizes interrupted activity. Review permissions before continuing migrated
chats. V1 plugin implementations require v2-compatible replacements; migration
does not rewrite configuration, skills, or plugin files.

## Upstream contract reviewed

Implementation was checked against the native engine at the repository pin,
`2.0.26`, and its upstream source commit
`9b4ec5714d481559990db0a816d5dec19541a814`:

- [Native migration](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/database/v1-migration.bun.ts)
- [Migration status API](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/protocol/src/groups/migration.ts)
- [Native session transfer](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/session/transfer.ts)
- [V1 compatibility guide](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/services/www/src/docs/content/migrate-v1.mdx)

## Verification

`apps/server/test/opencode-v2-staged-history.test.ts` is an isolated integration
test against the pinned real engine. It creates a 260 MiB single tool output,
Unicode text, base64 and percent-encoded files, and multiple transfer batches.
It kills a worker after a committed batch, resumes from another process,
checks complete payloads and the original database digest, leaves existing v2
chats untouched, and opens the result through a fresh native engine. It also
checks graceful shutdown and automatic startup recovery. Without a binary it
explicitly skips.

```sh
OPENWORK_OPENCODE2_BIN="$(command -v opencode2)" pnpm --filter openwork-server test:history-migration
```

The same integration can be bundled and run on Node with a small V8 heap to
exercise the desktop database implementation. No production history, provider
credentials, external records, or inference are needed.

Design: P3 (details disclosure), P5 (existing Button, AlertDialog,
Dialog, Progress and Alert), P9 (migration data and risks), C1 (verb-first
actions), and C6 (retryable errors).
