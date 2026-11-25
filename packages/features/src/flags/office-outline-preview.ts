import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: PowerPoint and Word outlines",
  description: "Read PowerPoint slides and Word documents as text in the chat side panel, without opening another app.",
  category: "experience",
  added: "2026-11-20",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/office-outline-preview/README.md",
  deployments: everywhere,
  default: false,
})
