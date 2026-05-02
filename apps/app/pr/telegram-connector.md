# PRD: Telegram Connector

## Summary
Add a Telegram connector panel to the OpenWork desktop settings UI so users
can link a Telegram bot to their workspace without touching config files.

## Problem
The opencode-router binary already supports Telegram via grammy.
The OpenWork server already proxies /opencode-router/* routes.
But there is zero UI to configure this. Users are blocked.

## Solution
A settings panel under Connections where users paste a bot token,
see live status, and can disconnect.

## Architecture Rules Followed
- UI never calls opencode-router directly — proxied through openwork-server
- Bot token is write-only (cleared from state after submit)
- opencode-router stays optional — disabling Telegram cannot crash OpenWork
- Identity upsert passes workspacePath as defaultDirectory (per ARCHITECTURE.md)
- CUPID domain structure: apps/app/src/app/connections/telegram/
