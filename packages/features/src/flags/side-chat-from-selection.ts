import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: start a side chat from selected text",
  description: "Selecting text in a reply shows a small Start a side chat bar above it. Choosing it opens a side chat beside the conversation with the text quoted in the message box.",
  category: "experience",
  added: "2026-11-20",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/side-chat-from-selection/README.md",
  deployments: everywhere,
  default: false,
})
