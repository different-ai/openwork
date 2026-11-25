import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Suggestions anywhere in a message",
  description: "Find skills with / and reference tasks, files, agents, and computers with @ anywhere in a chat draft.",
  category: "experience",
  added: "2026-11-23",
  since: "2026-11",
  author: "different-ai",
  docs: "docs/features/composer-inline-suggestions/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
