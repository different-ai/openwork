import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Deployment configuration changes",
  description: "Organization admins edit an installed AWS deployment's configuration, or turn on the gateway runtime and cloud computers later, and approve the change in their own AWS account without waiting for a newer installer.",
  category: "administration",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/managed-deployment-config-updates/README.md",
  deployments: ["cloud"],
  default: false,
})
