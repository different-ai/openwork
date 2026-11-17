import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Continue archived conversations",
  description: "Write a follow-up in an archived conversation and unarchive it when you send.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "yomgui",
  docs: "docs/features/archived-session-compose/README.md",
  deployments: everywhere,
  default: false,
})
