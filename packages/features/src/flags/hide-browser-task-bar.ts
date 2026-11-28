import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: no status bar above the built-in browser",
  description: "The built-in browser no longer shows the bar with the agent's status and the Take over button above the address bar.",
  category: "experience",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/hide-browser-task-bar/README.md",
  deployments: everywhere,
  default: false,
})
