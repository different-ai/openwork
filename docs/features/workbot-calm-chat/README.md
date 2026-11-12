# Workbot: calm chat look

Feature: `workbotCalmChat` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

A quieter look for Workbot's chat. Looks only: chats, files, browser tasks, navigation, wording and data are the same with the flag on or off.

## What changes

- **Sidebar.** On the chat page the icon rail and the chat list become one 240px column on the tray grey: Workbot's mark and name, the pages (Chats, Documents, Calendar) as labelled rows with the open one a white pill with a hairline ring, then the same chat list (filter, Main chat, Side chats). Documents and Calendar keep the icon rail.
- **Header.** Workbot's avatar, name and live status sit in one centred pill, on desktop and phone. A small green dot pulses while Workbot is working, next to the same activity label as before.
- **Conversation.** The column is 560px wide instead of 800px, with more space between turns. Text is 13px on 21px lines on desktop (14px on phones). The person's message is a soft grey bubble on the right; Workbot's reply keeps its white ringed bubble.
- **Browser card.** A small card with a hairline ring: thumbnail, title, the same status line and an outlined "Open preview" pill. The live preview still shows while Workbot is browsing.
- **File card.** Unchanged: the large preview with the file's icon, name and type underneath.
- **Message box.** A pill with the round send button and a very soft shadow under the hairline.

Step rows, the task sheet, the first-open screen, errors and every menu are unchanged.

## Try it

Turn the flag on for a test organization in `/admin` → organization → Features. Locally: add `&calm=1` to the chat-screen fixture, for example `?chatlist=1&sideChats=1&documents=1&calendar=1&profile=1&working=1&browser=1&scenario=artifacts&calm=1`. Scenarios `empty`, `failed` and `long` cover the empty chat, a failed turn and long messages. Screenshots are in the PR.

## Turning it off

The chat goes back to the icon rail, the avatar-over-name header, and the 800px column. Nothing is stored.
