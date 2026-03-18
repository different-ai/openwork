---
name: browser-setup
description: Try Control Chrome first, then explain setup if Chrome MCP is unavailable
---

Try browser automation in OpenWork right away.

IMPORTANT:
- Prefer Chrome DevTools MCP / `chrome-devtools_*` tools first.
- If those tools are available, use them in your first response to open `https://example.com` and tell the user the page title.
- If those tools are not available, do not invent substitute tools and do not fall back to Playwright first.
- Instead, tell the user the shortest exact steps to connect `Control Chrome` from OpenWork's MCP tab, then ask them to retry.

Keep the response short and action-oriented.
