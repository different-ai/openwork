import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: chat and side panel as flat columns",
  description: "In the desktop app the chat and the side panel fill the window as two flat columns split by a thin line, and the side panel's tabs sit in the title bar.",
  category: "experience",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/flat-session-panes/README.md",
  deployments: everywhere,
  default: false,
})
