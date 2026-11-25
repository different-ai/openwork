import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Managed Google Cloud deployments",
  description: "Allow the workspace to prepare and approve OpenWork installations and updates in Google Cloud. An installer release must also be configured.",
  category: "administration",
  added: "2026-11-23",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/managed-google-cloud-deployments/README.md",
  deployments: ["cloud"],
  default: false,
})
