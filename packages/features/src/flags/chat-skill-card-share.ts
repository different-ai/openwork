import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Chat: share created skills",
  description: "Share a skill from its result card in chat without leaving the conversation.",
  category: "experience",
  added: "2026-11-18",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/chat-skill-card-share/README.md",
  deployments: everywhere,
  default: false,
})
