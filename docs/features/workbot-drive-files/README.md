# Workbot: reading Drive files

- Feature: `workbotDriveFiles`
- Deployments: cloud and self-hosted; default **off**
- Owner: `benjaminshafii`

## What changes

Only Workbot's instructions change; no tool, permission or capability changes.

Without the feature, Workbot's instructions only say to reach apps with
`search_capabilities` then `execute_capability`. For a PDF, Word, Excel or
PowerPoint file in Google Drive it usually picks the inline Drive file read,
which returns small text only (non-text files over 64 KB come back empty as
`file_too_large`). It then tells the person the file is too large, even though
its computer has `curl`, `pdftotext`, pandas and python-docx.

With the feature on:

- **Workbot web chats** (`workbotInstructions` in
  `ee/packages/workbot-server/src/service.ts`; every Workbot conversation is set
  up with its computer): for PDFs, Office files and anything large in Google
  Drive or OneDrive, Workbot pulls the file onto its computer with
  `createGoogleDriveDownloadLink` (or `createMicrosoft365DriveDownloadLink`),
  saves it into `/workspace` with curl and reads it with shell tools, the path
  the built-in `drive-files` skill already describes. The runner leaves the
  computer out of read-only turns (an open document's context, task reports),
  so the instruction says what to do then: use the inline read, and if the
  file is too large or has no text, say so plainly and ask the person to send
  it in the chat or ask again in a normal message.
- **Slack** (`slackWorkbotInstructions` in
  `ee/apps/den-api/src/slack-assistant/protocol.ts`): Slack turns have no
  computer. Workbot reads Drive files inline and, when one is too large or has
  no text, asks the person to share it in the thread (Slack files up to about
  10 MB are opened by the runner), instead of saying it can do nothing. The
  choice is made once per message, like the rest of the Slack session setup.
- **Your agent** (proactive check-ins) is unchanged: its sessions have no
  computer and it does not read Drive files on request.

## Try it

1. Turn `workbotDriveFiles` on for a test organization (or member) in
   `/admin` › Features. Workbot picks it up the next time a chat's session is
   refreshed (the next message).
2. In Workbot, ask about a PDF of a few hundred KB in Google Drive. It should
   download it on its computer and quote it.
3. In Slack, ask the same: when the inline read can't return the text, it asks
   you to share the file in the thread.

## Turning it off

The next message's session setup drops the text again. Nothing is stored.

## What to watch

Workbot turns that call `createGoogleDriveDownloadLink`, and replies that still
say a Drive file is too large.
