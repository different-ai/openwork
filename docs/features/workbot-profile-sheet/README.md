# Workbot: profile

Feature key: `workbotProfileSheet` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

Needs `workbotWorkingStatus`: Den reports it on only when both are on, since the profile opens from the name that carries the status line.

## What people see

Tapping Workbot's name in the header opens its profile, on every screen size: a panel on the right on desktop, and on phones (where the name pill stands in for the avatar) the same profile as a full-height sheet under the status bar, with a grabber to pull it down. It shows the mark, its name, and whether it is at work ("Opening your screenshot") or ready. Three tabs, one at a time:

- **Tasks**: the reply in progress with its steps, then one row per background task (title, one plain status line, a time, and Stop while it runs); a task's steps open inside its row, repeats counted ("Checking the remote task · 7 times"). The same content as the task sheet.
- **Apps** ("What I can use"): every app the person can use, connected or not, in one list: Connected first, then Needs sign-in, Not connected and Needs attention, each with its logo (or first letter) and a plain status. One **Connect** (the existing Workbot connect flow) where the person signs in with their own account, including an expired sign-in; "Ask your admin" where only an admin can fix it ("Fix in OpenWork settings" for someone who can manage connections). Then what Workbot can do (browser, computer, documents, calendar), with off ones listed and locked rather than hidden. A link to manage connections in Den.
- **What I remember**: Workbot's memory files about the person (`memory/*.md` of their main chat, shared with side chats), newest first, read-only. To change something, they tell Workbot.

![Profile on a phone: Tasks, What I can use, What I remember](profile.png)

There is no Computer tab: Workbot's browser and computer open only from a step's card in the chat. Callers can open the sheet on a tab with `initialTab` (`"tasks"`, `"permissions"` for Apps, `"schedules"`, `"memory"`).

Not in this version: editing the name or avatar, a personality ("Soul") editor, browser tabs with thumbnails, and schedules.

## How it works

- Den's `GET /v1/workbot/session` returns `profileSheet`; Workbot's `/v1/workbot/me` passes it to the page.
- `GET /v1/workbot/memory` (404 `feature_disabled` without the flag) lists the runner's scratch files (`GET /v1/sessions/:id/files`), keeps `memory/*.md|txt` at the top level, and reads at most 12 files, 8,000 characters each.
- Apps come from `apps` on `GET /v1/workbot/connections` (Den returns it only with this flag; older Dens leave it out and the list falls back to the everyday connections). "Every app the person can use" is what Den's Your connections lists for them: connections shared with them org-wide, through a team or directly, those brought by plugins and skills they can use, the native providers (Google Workspace, Microsoft 365) their organization set up, and their own sign-ins. Not the marketplace catalog, and not connections shared only with others.
- Status comes only from what Den already stored (the member's or shared credential health, issuer review, the last readiness check, and plugin setup), so opening the list never contacts a provider. Each app carries only its id, name, native provider key, sign-in type, status, who manages it, what the person can do, and Den's connect link while they could connect it: never its URL, headers, keys or tokens.
- Logos use the same shared brand resolver as Den's connector catalog (`@openwork/types/connector-brand`): known bundled marks/CDN images, then trusted icon metadata when available, then the existing sized favicon proxy for a public service domain, then a letter. Native provider identity takes priority over a renamed account. Connector URLs stay on the server: only derived image candidates leave it, with no paths, query credentials, headers or tokens from the MCP URL. There is no persisted MCP-server icon metadata on connection facts today, so opening Apps does not fetch server metadata. The standalone Workbot host resolves bundled images against Den's configured origin. The same resolver supplies chat connector marks, including Exa.
- Duplicate imported slugs are removed from display names (`Coffee SF / coffee-sf` → `Coffee SF`; distinct account suffixes remain). Apps logos occupy fixed 32px light tiles with 18px images, including during loading or fallback.
- Nothing new is stored.

## Turning it off

The name opens the task sheet again; `/v1/workbot/memory` answers 404. Nothing is stored by the feature.
