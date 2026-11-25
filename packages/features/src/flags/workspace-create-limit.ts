import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Limit workspaces per person",
  description: "Refuse new workspaces once one person has created the configured number in the rolling window. Platform admins can raise the limit for one account.",
  category: "administration", added: "2026-11-24", since: "2026-11", author: "reachjalil",
  docs: "docs/features/workspace-create-limit/README.md", deployments: everywhere, default: false,
})
