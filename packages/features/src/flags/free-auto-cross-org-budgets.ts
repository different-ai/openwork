import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Cross-organization free model budgets",
  description: "Share signed-in free usage across organizations with the same founder and accounts on the same desktop. Enable for everyone on the deployment.",
  category: "models",
  added: "2026-11-23",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/free-auto-cross-org-budgets/README.md",
  deployments: everywhere,
  default: false,
})
