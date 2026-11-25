import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Computer suggestions in chat mentions",
  description: "Offer Cloud and Desktop as choices when someone types @ in chat.",
  category: "computerUse",
  added: "2026-11-25",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/composer-computer-mentions/README.md",
  deployments: everywhere,
  default: false,
})
