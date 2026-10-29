# Outlook attachments

- Feature: `outlookAttachments`
- Deployments: cloud and self-hosted
- Author: `reachjalil`
- Default: off

## What changes

Members with a connected Microsoft 365 account get two things:

| What | Where |
|---|---|
| Read the files attached to an Outlook message | Den capabilities `mail-attachments/{messageId}` (list) and `mail-attachment/{messageId}/{attachmentId}` (bytes as base64, up to 10 MiB), for any agent through Connect |
| Create an Outlook draft, or a reply draft, with workspace files attached | The desktop's v2 `openwork_outlook_draft` tool and the v1 `outlook_create_draft_with_attachments` host action, through `POST /v1/direct-uploads/microsoft-365/mail-drafts` |

Not visual: there is no new screen. The approval prompt is the engine's usual
permission prompt in the chat.

How a draft with attachments works:

1. The agent calls the tool with recipients and subject (or the id of the
   message to reply to), a body and up to ten workspace paths.
2. On v2 the person approves that draft in the chat. Declining, a rule that
   would allow it without asking, or a blocking rule creates nothing.
3. The desktop reads the files from authorized workspace roots and sends them
   to Den as multipart, outside model context.
4. Den creates the draft (Graph `POST /me/messages` or `createReply`), then
   attaches each file (`POST /me/messages/{id}/attachments`). Drafts are
   never sent.
5. If a file cannot be attached, Den moves the new draft to Deleted Items and
   says so; if even that fails, it says the draft may remain in Drafts.

Limits: up to ten files, each under 3 MB (Graph's single-request attachment
limit) and 4 MiB in all, the same total as Gmail drafts. Larger files need an
attachment upload session, which this does not do yet.

Permissions: reading needs the connector's Outlook mail read feature
(`Mail.Read`); drafts need Outlook draft creation (`Mail.ReadWrite`). No new
Microsoft permission is requested.

## How to try it

1. Turn `outlookAttachments` on for your organization in `/admin` › Features.
2. Connect a Microsoft 365 account with mail read and draft creation enabled.
3. In the desktop app (OpenCode v2), ask: "Draft an email to me in Outlook
   with report.pdf attached." Approve the prompt, then open Outlook Drafts.
4. Ask an agent to read the attachments of a recent Outlook message.

## Turning it off

The two read capabilities leave the capability catalog and both they and the
draft route answer 404 `feature_disabled`. The desktop tool stays listed and
reports that Outlook attachments are not turned on, without creating a draft.
Drafts already created stay in the member's mailbox.

## What to watch

- Den logs for `Microsoft 365 mail attachment add` and
  `Microsoft 365 mail draft delete` failures.
- Reports of drafts left in Drafts without every file (the unknown-outcome
  message).
