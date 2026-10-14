# Feature-gated desktop identity and rollback storage contract

The backend resolves the central `whiteLabel` feature into the bootstrap's
`whiteLabelEnabled` boolean. Only explicit `true` permits custom native identity
or asset fetching. False or missing uses the packaged OpenWork identity, cancels
in-flight native work and restores stock OS identity without deleting source
settings/cache. Restart/offline boot retains the last explicit persisted decision;
legacy brand metadata, config presence and old links never imply enablement.

## Staying on the original target

Reads and ordinary same-origin writes retain the original `brandAppName`,
`brandLogoUrl`, and `brandIconUrl` values, including null/absent fields. Incoming
stock wire or disabled renderer strings cannot replace them. Explicit enabled
writes may update them from effective Den config. Native cleanup restores only
owned stock shortcuts; unrelated links cannot be deleted or overwritten. Disabling
leaves image files and their sidecar unchanged for re-enable and rollback.

## Switching target or organization

Before changing the Den web/API origin, the shell archives the original dormant
settings and moves the old root-level image cache into:

```
<userData>/desktop-brand-rollback/<target-and-known-org-sha256>/snapshot-*/
  settings.json
  brand-icon.json
  brand-icon.png
  brand-icon.ico
  openwork-stock.ico
```

Only existing files are moved. Their bytes and filesystem metadata are retained.
`settings.json` contains the original target and dormant values, plus the org ID
when known from a prepared/handoff record. It contains no grants or claim tokens.
The old desktop does not search these archive paths. In particular, its boot-time
cache loader cannot accidentally use the previous target's sidecar on the new
target. No archive is automatically applied by the current desktop.

For a **confirmed same-origin organization switch**, the renderer sends all three
brand fields explicitly as `null`. The shell archives the original settings and
cache first, then clears the active dormant fields. While the flag is off, a
stock wire payload cannot replace originals; it is not the explicit all-null
organization-switch request. The live bootstrap also retires prepared/handoff
records tied to the previous organization; a later branding refresh cannot
reintroduce those records or associate the new branding with the old org. The
previous enrollment remains available only through its trusted transaction
snapshot, not the new organization's active configuration.

Bootstrap reads return an opaque process-local `rollbackSnapshotId`. During a
failed handoff transaction the renderer forwards the previously read ID as
`restoreSnapshotId` in the setter input. The shell checks its own receipt table
and the destination origin before restoring its saved dormant values/cache.
When both the snapshot and destination identify known orgs via prepared/handoff
records, their org IDs must also agree. Unscoped/MDM data is not assigned an owner
based on asset URLs. Rejected restores change neither active storage/cache nor
source archives. Restore receipts use shell-owned brand strings and archive paths,
not caller-supplied replacements. This does not restore/override feature enablement,
activation or other security policy. Receipts are
never written to disk, are bounded to the latest 64 distinct snapshots, and expire
on restart.

At a switch, the shell associates the archived cache with every still-valid
receipt for that exact source identity: matching web/API origins, matching known
org sets (including both unscoped), and identical dormant settings. An unrelated
same-target write may change timestamps/policy without losing an older receipt's
cache. Existing archive associations are immutable: later org switches, branding
versions, or exact-config receipt aliases cannot redirect a historical receipt
to a newer cache. Every archived source copy is retained.

## CLI and manual rollback

CLI desktop preparation preserves original settings/cache for the same Den and
known org, and archives them on an origin or known-org change. It resolves the
standard production Electron user-data path. For a custom/dev profile, set the
existing `OPENWORK_ELECTRON_USERDATA` override to that profile's actual directory
when running the CLI; the CLI cannot discover an unrelated running profile.

After a completed target/org switch, restoring an archive is an **explicit
operator action**, not automatic branding behavior: quit the desktop, restore
only the dormant settings and cached files belonging to the intended original
Den/org, and ensure the bootstrap points to that same target before starting an
older desktop. Do not copy another target's cache into its root lookup paths.
Keep the archive as the source copy. In-process transaction rollback performs
this scoped restoration through its shell-issued receipt instead.

## Limits

- An arbitrary external editor that changes the bootstrap target while bypassing
  both shell and CLI writes also bypasses cache archival. Before reverting after
  such a manual change, explicitly archive the old root-level cache. The current
  desktop only applies a cache matching the explicitly enabled config's source
  URL; older boot code is not target-aware.
- If no prior org identity is recorded, CLI cannot infer a same-origin org change
  from a brand URL. It preserves data rather than guessing ownership. Confirmed
  organization changes through the renderer use the explicit all-null protocol.
- Receipt restoration is an in-process transaction mechanism, not a persistent
  restore API. After restart, use the scoped archive and deliberate manual steps.
- Explicit destructive reset/nuke behavior is not a backup service: preserve any
  rollback archives outside reset paths before performing such an operation.
- Tests cover real storage/cache transitions and the old cache lookup contract;
  they do not constitute a packaged older-desktop or native Windows shell run.
