import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Managed deployments",
  description: "Organization admins install OpenWork in their own AWS account or Google Cloud project and see its health and updates in OpenWork, and agents connected to OpenWork can create and follow those deployments.",
  category: "administration",
  added: "2026-10-08",
  since: "2026-10",
  author: "benjaminshafii",
  docs: "docs/managed-deployments.md",
  deployments: ["cloud"],
  default: false,
})
