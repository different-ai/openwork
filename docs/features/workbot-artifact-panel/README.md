# Workbot: artifacts open beside the chat

Files Workbot makes while answering (apps, documents, spreadsheets, images) appear under the reply as cards and open in the same panel and phone sheet as browser tasks. This is the default for everyone; there is no flag.

## What people see

Each file is a card: a large rounded thumbnail of the file itself, then a small type icon, the title and the type ("App", "PDF", "Spreadsheet"). One file shows one large card; several share a two-up grid. The thumbnail is real when Workbot has one: an image shows itself, a PDF, deck or document shows the first page Workbot's computer rendered, and an HTML app shows its page scaled down as it looks before its scripts run. A card never runs the app: scripts, event handlers, frames, links, refresh tags and every outside address are stripped, a policy blocking all requests goes first, and the frame has an empty sandbox (no scripts) and takes no input or focus. A page with nothing to show without its scripts gets the placeholder. The app runs only when the person opens it. Anything else shows a quiet placeholder tinted by its type. An app goes by its own `<title>`; other files by their name without the extension. The open file's card is outlined.

Tapping a card opens the file. On a desktop the conversation stays on the left in a 400–600px column (33vw) and the file takes the rest of the width; navigation folds into the drawer while it is open, as it does for the browser. On a phone the file opens as a full-screen sheet. Both have the same minimal header: type icon, title, **More** (…) and **Close**. More holds Expand / Show the chat (desktop only), Open in new tab (apps, PDFs, images, video, audio), Download, Copy link and, where the device can, Share. Esc or Close returns to the chat, and focus goes back to the card. Files the person sent, and files opened from the Files list, use the same panel.

Copy link copies this page's address with `?artifact=<file id>`. Opening it (signed in to the same chat) opens that file once the conversation is read, then removes the parameter. Open in new tab never gives a file this site's origin: an app runs in a sandboxed frame in the new tab; other kinds open as their own blob.

When Workbot revises an open file, the panel follows its newest version and says "Updated just now".

## What was removed

The old file chips under replies (`OutputFiles`) and the separate docked/fixed `PreviewPanel` with its Download button and "HTML, 2 KB" subtitle. The readers for each file type are unchanged.

## Verification and delivery

`pnpm --filter @openwork-ee/workbot test:artifact-ui` renders the cards (thumbnail, title, type, open state). `test:artifact-browser` drives the real screen against the in-memory fixture (`?scenario=artifacts`) at 1440px, 1920px and iPhone size: tap opens the panel or sheet, the header is title + More + Close, More holds the secondary actions, Close returns to the chat; and `?scenario=artifact-hostile` checks that a card for an app that tries to fetch, load images, import CSS and navigate makes no request. These are UI checks, not live runner evidence.

Deploy the Workbot chat web service to deliver this. No server, runner or Den change.
