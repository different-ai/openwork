import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Agent connector controls",
  description: "New personal agents only use the apps chosen for them. If an agent needs another app, it can ask a person for access.",
  category: "workbot",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/personal-agent-connector-controls/README.md",
  deployments: ["cloud"],
  default: false,
})
