import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: pick effort from the composer",
  description: "The composer always shows the chosen effort after the model name, and clicking it opens the effort list directly instead of the model list.",
  category: "models",
  added: "2026-11-17",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/effort-quick-pick/README.md",
  deployments: everywhere,
  default: false,
})
