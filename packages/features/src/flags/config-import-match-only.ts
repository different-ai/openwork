import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Config import: only change what already exists",
  description: "A configuration import can be told to create nothing: an item the organization does not already hold is blocked in the plan until it is matched to an existing item or left out. For now through the API only.",
  category: "administration",
  added: "2026-11-15",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/config-import-match-only/README.md",
  deployments: everywhere,
  default: false,
})
