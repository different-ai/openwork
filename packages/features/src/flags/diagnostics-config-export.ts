import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Diagnostics: installation configuration",
  description: "On a self-hosted install, installation administrators see a Configuration row in Settings › Diagnostics with the running version, the Helm chart's versions and a warning when they differ, and can copy or download it with capability states and locked features to send to support. Versions, fixed states and feature keys only, never a setting's value. Turning it off removes the row; nothing else changes.",
  category: "administration",
  added: "2026-11-24",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/diagnostics-config-export/README.md",
  deployments: ["self_hosted"],
  default: false,
})
