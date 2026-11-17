import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Operational diagnostics",
  description: "Write an optional, fixed-schema operational snapshot locally.",
  category: "administration",
  added: "2026-11-16",
  since: "2026-11",
  author: "openwork",
  docs: "docs/features/operational-diagnostics/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
