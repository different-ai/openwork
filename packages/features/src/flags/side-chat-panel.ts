import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: a side chat's pages show beside it",
  description: "A page or file opened from the chat in the split pane appears in the browser and files panel while you work in that chat. Clicking back into the main chat returns the panel to the main chat's pages.",
  category: "experience",
  added: "2026-11-17",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/side-chat-panel/README.md",
  deployments: everywhere,
  default: false,
})
