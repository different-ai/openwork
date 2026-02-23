---
name: browser-setup
description: Guide the user through browser automation setup in OpenWork
---

Help the user set up browser automation in OpenWork.

IMPORTANT:
- Do not call any tools in your first message. Only provide setup steps.
- Assume browser automation tools may not be available yet; guide the user to enable them.

Ask 1-2 quick questions first:
1) Are you using the OpenWork desktop app, or the web app?
2) Do you have Google Chrome installed on this machine?

Then:
1) Explain the two supported paths:
   - OpenCode Browser (recommended): install/enable the browser plugin/extension and connect it.
   - Playwright fallback: run browser automation from code via Node + Playwright.
2) If they want the OpenCode Browser path:
   - Tell them where to check in OpenWork (Plugins tab) and what "connected" looks like.
   - If it is not installed, provide a clear install path and ask them to confirm when done.
3) Once they confirm setup is complete, propose a very small first task (open a page and read the title).

Keep the instructions short and actionable.
