import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Free Auto safety pauses",
  description: "Allow platform administrators to pause included model usage for a reviewed safety identifier.",
  category: "models",
  added: "2026-11-23",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/free-auto-safety-pauses/README.md",
  deployments: everywhere,
  default: false,
})
