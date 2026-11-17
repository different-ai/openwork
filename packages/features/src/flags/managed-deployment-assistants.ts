import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Managed deployment assistants",
  description: "Organization admins add a managed runner, Workbot, Slack assistants and optional cloud computers to OpenWork in their own AWS account.",
  category: "administration",
  added: "2026-11-16",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/managed-deployment-assistants/README.md",
  deployments: ["cloud"],
  default: false,
})
