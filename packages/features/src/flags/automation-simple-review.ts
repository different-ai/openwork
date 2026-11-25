import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Automations: simpler chat review",
  description: "See what an Automation will do, when it runs, and where, with setup options one click away.",
  category: "automations",
  added: "2026-11-20",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/automation-simple-review/README.md",
  deployments: everywhere,
  default: false,
})
