# React Session Hard-Cut Checklist

This file freezes the non-negotiable Session and Composer parity contract for the
`apps/app` React cutover. It is the implementation checklist that must be true
before removing the Solid runtime path.

## Composer

- The connector/tools icon opens a menu with `commands`, `skills`, and `mcps`.
- The tools menu can open the correct settings destination for each section.
- Slash commands preserve command-vs-skill-vs-MCP discoverability and labeling.
- Attachment limits, accepted types, and user-facing error states are aligned.
- Notices, paste warnings, send/stop disable rules, and agent/model pickers match
  the pre-cutover behavior.
- Composer-visible copy uses i18n where the Solid composer already did.

## Transcript And Session

- Streaming transcript rendering matches the current session behavior.
- Tool calls, reasoning visibility, file actions, permissions, and questions still
  work after the cutover.
- Empty state preserves blueprint/starter behavior instead of falling back to a
  generic placeholder.
- Earlier-message loading is retained or deliberately replaced.
- Scroll behavior supports both follow-latest and manual reading without
  regressing session navigation.
- Large-session behavior is verified before deleting Solid-only transcript
  mechanics.

## Navigation And Settings

- Session URLs and missing-session redirects stay stable.
- Settings routes keep the same tabs and deep-link behavior.
- Composer and session shortcuts still land on the same settings destinations.
- Session runtime sync has one clearly defined bootstrap condition after the hard
  cut.
