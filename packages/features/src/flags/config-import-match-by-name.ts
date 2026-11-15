import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Config import: match plugins and skills by name",
  description: "When a configuration file is imported, a plugin or skill that the organization already shares under the same name is planned as the same item (an update, or nothing to change) instead of a second copy. Off, such an item is planned as a new one unless an earlier import of the file created it.",
  category: "administration",
  added: "2026-11-15",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/config-import-match-by-name/README.md",
  deployments: everywhere,
  default: false,
})
