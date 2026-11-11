# Workbot: Apps built in OpenWork open in the chat (`workbotApps`)

- **Feature key:** `workbotApps`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

When Workbot builds, changes or opens an App with OpenWork's App tools
(`create_app`, `update_app`, or opening an App it found), the App shows as a
card under the reply, next to any files the reply made. Tapping the card opens
the App itself beside the chat (a full-screen sheet on a phone), in the same
panel files open in.

![An App built in OpenWork, opened beside the chat from its card](./workbot-apps.jpg)

The screenshot is the test fixture screen (`?scenario=openwork-app`), not a
live workspace: the App card sits next to an `.html` file's card, and the open
App has run its own tool twice.

## App or web page

Workbot can make two things a person uses, and the cards say which:

| | App | Web page |
|---|---|---|
| What it is | Built in OpenWork with its App tools | One `.html` file Workbot hands over |
| For | Something to keep and come back to, share with a team, or that works with connected apps | A one-off: a mock-up, a game, a visual, something to download |
| Where it lives | In OpenWork, with the person's other Apps | In the chat's Files |
| Card | "App", window icon | "Web page", globe icon |
| More menu | Expand, Copy link | Also Open in new tab, Download, Share |

With the feature on, Workbot is told to pick by what the person needs, to make
the one they name, and to ask in one line when unsure. Before this change an
`.html` file's card also said "App"; it now says "Web page" for everyone, so
the word App means one thing.

Off: the App is still made, but nothing shows in the chat, as before.

## How it works

- **Runner.** A tool result that launches an App built in OpenWork (Connect's
  `openwork/mcpApp` launch of the App's own `open_app`) keeps the App's id and
  title on the stored tool message. The model reads only the result's text.
  This is kept whether or not the feature is on; nothing shows it while off.
- **Workbot's server.** With the feature on, those Apps are listed among the
  reply's outputs (`app:<App id>`, type `application/vnd.openwork.app`), each
  once, as last named. Workbot is also told the App shows as a card, so it does
  not say it opened "in the sidebar".
- **Opening one.** `POST /v1/workbot/apps/<App id>/open` asks the App's own MCP
  server (`/mcp/agent/connections/<App id>`) with the person's own sign-in:
  `open_app`, then the App's page. Den decides there whether they may use the
  App. `POST /v1/workbot/apps/<App id>/call` runs one of the App's own tools
  the same way.
- **The page.** The App's page runs in a frame with an opaque origin (scripts
  and forms, never `allow-same-origin`), so it cannot read Workbot's page, its
  sign-in or the conversation. Workbot answers the App's MCP Apps requests:
  the opening result, calls to the App's own tools, and web links (http and
  https, in a new tab).

## Limits

- The App's tools run as the person, with no extra prompt, as they do when the
  App is opened as a site (`appSites`).
- An App cannot send Workbot a message or change what Workbot knows: those
  requests are refused.
- Only Apps built in OpenWork. An App that a connected service brings is not
  shown.
- A card has no picture of the App; it shows the App type until opened.
- The App opens fresh each time, without the input it was first launched with.

## Turning it off

Safe at any moment: cards for Apps stop being listed and the two routes answer
`feature_disabled`. Apps themselves, files and their cards are untouched.

## Verification

`pnpm --filter @openwork-ee/headless-runner test:conversation` (the launch is
kept), `pnpm --filter @openwork-ee/workbot test:steps` (listed once, only when
on) and `test:artifact-ui` (the card, and what the App's page may ask for).
The fixture screen runs a small App end to end. Not run against a live Den.
