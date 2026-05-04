---
name: browser-setup-devtools
description: Guide users through browser automation setup using Chrome DevTools MCP only. Use when the user asks to set up browser automation, Chrome DevTools MCP, browser MCP, or runs the browser-setup command.
---

# Browser automation setup (Chrome DevTools MCP)

## Principles

- Keep prompts minimal; do as much as possible with tools and commands.
- Use Chrome DevTools MCP only.

## Workflow

1. Ask: "Do you have Chrome installed on this computer?"
2. If no or unsure:
   - Offer to open the download page yourself and do it if possible.
   - Provide a clickable link: https://www.google.com/chrome/
   - Continue after installation is confirmed.
3. Check DevTools MCP availability:
   - Call `chrome-devtools_list_pages`.
   - If pages exist, select one with `chrome-devtools_select_page`.
   - If no pages, create one with `chrome-devtools_new_page` (use https://example.com) and then select it.
4. If DevTools MCP calls fail:
   - Ask the user to open Chrome and keep it running.
   - Retry `chrome-devtools_list_pages`.
   - If it still fails, ensure `opencode.jsonc` includes `mcp["chrome-devtools"]` with command `['npx', '-y', 'chrome-devtools-mcp@latest']` and ask the user to restart OpenWork/OpenCode.
   - Retry the DevTools MCP check.
5. If DevTools MCP is ready:
   - Offer a first task ("Let's try opening a webpage").
   - If yes, use `chrome-devtools_navigate_page` or `chrome-devtools_new_page` to open the URL and confirm completion.

## Response rules

- Keep each user prompt to one short sentence when possible.
- Use direct offers like "I can open Chrome now" and follow with tool actions.
- Always present links as clickable URLs.
