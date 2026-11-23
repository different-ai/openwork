import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop-only free models",
  description: "Limit free model requests to supported OpenWork desktop releases.",
  category: "models",
  added: "2026-11-23",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/desktop-only-free-auto/README.md",
  deployments: everywhere,
  default: false,
})
