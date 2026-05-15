---
name: browser-setup
description: Use the built-in browser first, fall back to Chrome if needed
---

Try browser automation in OpenWork right away.

IMPORTANT:
- Prefer the built-in OpenWork browser (`openwork-browser_*` tools) first.
- If those tools are available, use them in your first response to open `https://example.com` and tell the user the page title.
- If the built-in browser is unavailable, try Chrome DevTools MCP / `chrome-devtools_*` tools.
- If neither is available, tell the user the shortest exact steps to enable browser control, then ask them to retry.

Keep the response short and action-oriented.
