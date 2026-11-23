import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Shared Free Auto budgets",
  description: "Limit included model usage across members of an organization and across signed-in users.",
  category: "models",
  added: "2026-11-23",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/free-auto-shared-budgets/README.md",
  deployments: everywhere,
  default: false,
})
