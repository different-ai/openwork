# Workbot: pages on the left, the rest in its profile

Feature: `workbotProfileNav` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

Requires `workbotProfileSheet` and `workbotWorkingStatus` (Den sends `profileNav` only when all three are on).

## What changes

- The left navigation (desktop rail and phone drawer) lists only full pages: Chats, Documents and Calendar.
- Files and Apps open beside the chat rather than as pages, so they leave the navigation and become tabs in Workbot's profile: Tasks, **Files**, Apps, Schedules (centred profile) and Identity.
- The OpenWork logo at the top of the desktop rail opens that profile; on a phone, a "Workbot · Files, apps, memory" row at the top of the drawer does.
- The Files button in the chat header is hidden; opening a file from the profile's Files tab closes the profile and shows the file beside the chat, as before.

## Try it

Turn the flag on for a test organization in `/admin` → organization → Features. Locally, the chat-screen fixture shows it with
`?profile=1&working=1&centered=1&profileNav=1` (`pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3099`).
Screenshots are in the PR.

## Turning it off

The navigation goes back to listing Files and Apps, the header Files button returns and the profile loses its Files tab. Nothing is stored; no files or settings change.
