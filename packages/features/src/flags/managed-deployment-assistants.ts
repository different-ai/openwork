import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Gateway-managed deployments",
  description: "New AWS installations include the model gateway, managed runner, Workbot and Slack/Automations. Existing installations upgrade only with approval; cloud computers stay optional.",
  category: "administration",
  added: "2026-11-16",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/managed-deployment-assistants/README.md",
  deployments: ["cloud"],
  default: false,
})
