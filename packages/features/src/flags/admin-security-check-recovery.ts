import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Admin security check recovery",
  description: "Resume a paused security check from the workspace page and prioritize SSO for sessions started through SSO.",
  category: "administration",
  added: "2026-11-20",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/admin-security-check-recovery/README.md",
  deployments: everywhere,
  default: false,
})
