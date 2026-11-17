import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Client failure reports",
  description: "Receive content-free desktop failure reports for staff diagnostics.",
  category: "administration",
  added: "2026-11-16",
  since: "2026-11",
  author: "openwork",
  docs: "docs/features/client-failure-reports/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
