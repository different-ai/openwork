import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Automations: share with teammates",
  description: "Share one of your Automations with people, teams or your whole organization. They see it under Shared with you and can add their own copy, which runs with their own connections and models.",
  category: "automations",
  added: "2026-11-18",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/automation-sharing/README.md",
  deployments: everywhere,
  default: false,
})
