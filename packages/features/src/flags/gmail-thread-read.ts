import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Read Gmail threads",
  description: "Read the messages, headers, and labels in a Gmail conversation without loading full message bodies.",
  category: "connect", added: "2026-11-24", since: "2026-11", author: "yomgui",
  docs: "docs/features/gmail-thread-read/README.md", deployments: everywhere, default: false,
})
