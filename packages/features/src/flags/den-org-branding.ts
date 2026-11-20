import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Den: organization branding",
  description: "Show the organization's wordmark or icon and app name in the dashboard sidebar, and its app name in the browser tab.",
  category: "experience",
  added: "2026-11-20",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/den-org-branding/README.md",
  deployments: everywhere,
  default: false,
})
