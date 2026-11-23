import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Slash suggestions throughout a message",
  description: "Find skills by typing a slash and part of their name anywhere in a chat draft, including names with spaces.",
  category: "experience",
  added: "2026-11-23",
  since: "2026-11",
  author: "different-ai",
  docs: "docs/features/composer-slash-anywhere/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
