import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: expand a table in chat",
  description: "A table in a chat answer shows an expand button on hover that opens the table in a wide window, so long or many-column tables are easy to read.",
  category: "experience",
  added: "2026-11-19",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/chat-table-expand/README.md",
  deployments: everywhere,
  default: false,
})
