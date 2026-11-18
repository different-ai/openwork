import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: exact provider search and guided provider sharing",
  description: "The model picker shows only the provider and model you typed, and sharing a provider from this device waits until it is listed under your organization before saying it is shared.",
  category: "models",
  added: "2026-11-16",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/provider-filter-sync-fix/README.md",
  deployments: everywhere,
  default: false,
})
