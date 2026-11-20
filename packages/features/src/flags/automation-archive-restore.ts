import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Automations: restore from archive",
  description: "Find archived Automations and restore them without resuming their schedules.",
  category: "automations",
  added: "2026-11-20",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/automation-archive-restore/README.md",
  deployments: everywhere,
  default: false,
})
