import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Read Teams meeting transcripts",
  description: "Adds a Microsoft 365 permission that lets agents read a Teams meeting transcript for an event on the member’s calendar.",
  category: "connect",
  added: "2026-11-27",
  since: "2026-11",
  author: "getopenwork",
  docs: "docs/features/teams-meeting-transcripts/README.md",
  deployments: everywhere,
  default: false,
})
