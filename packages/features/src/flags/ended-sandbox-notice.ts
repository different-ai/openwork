import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Ended sandbox notice",
  description: "Tell members when their sandbox trial has ended and who can reopen it.",
  category: "experience",
  added: "2026-11-25",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/ended-sandbox-notice/README.md",
  deployments: everywhere,
  default: false,
})
