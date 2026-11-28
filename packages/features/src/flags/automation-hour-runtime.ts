import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Automations: configurable Cloud runtime",
  description: "Set an individual Cloud agent Automation's runtime limit to up to 60 minutes. Existing limits and creation defaults stay unchanged.",
  category: "automations",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/automation-hour-runtime/README.md",
  deployments: everywhere,
  default: false,
})
