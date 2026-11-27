import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Read Teams meeting transcripts",
  description: "Adds a Microsoft 365 permission that lets agents find a Teams meeting from its join link and read its transcript.",
  category: "connect",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/teams-meeting-transcripts/README.md",
  deployments: everywhere,
  default: false,
})
