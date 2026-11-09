## Per-team controls (Everyone and teams)

A setting that Everyone has and a team can change (Members › Teams › Everyone, and each team's page) follows one
pattern. Build new per-team panels from `team-scope.ts` (`TeamScope`) and `scoped-setting.tsx` in
`app/(den)/dashboard/_components/`; do not hand-roll these parts. The Workbot tab (`team-workbot-panel.tsx`) is the
reference.

- **Words:** call the organization level "Everyone", never "organization".
- **Row (`SettingRow`):** label on the left; on the right a chip, then one control; an optional line of state under it.
- **Chip (`ScopeChip`):** neutral "From Everyone" while the team follows Everyone; info "Changed for {team}" once it
  has its own value. On Everyone's page, a value teams changed shows "Changed for {team}" or "Changed for N teams".
- **Override:** the admin just changes the control. No "enable override" step and no "inherit" option inside the
  control. While a team follows Everyone, the control shows Everyone's actual value.
- **Go back (`UseEveryonesButton`):** one text button, "Use Everyone's", beside the chip, only while the team has its
  own value. No confirmation; it can be undone.
- **Save:** a single value saves on change and shows `SavedUndoLine`: "Saved. {what is now true}." with Undo. Typed
  text keeps a draft with Save and Discard.
- **Conflict (`ConflictLine`):** one line, only when true: "{n} members are also on a team with a different {setting},
  so they get Everyone's."
- **Read-only (`ReadOnlyNotice`):** keep the controls visible but disabled, with one notice at the top of the panel:
  a lock and "Read only. {reason}" from `permissionLockReason(...)`.
- **Everyone's value is edited on Everyone's page.** Other pages that show it link there.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
