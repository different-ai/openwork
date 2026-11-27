import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Microsoft 365: mail folders, profile, people and Teams channels",
  description: "Let agents read Outlook mail folders, view your profile, find colleagues, and list your teams and channels in Microsoft 365.",
  category: "connect", added: "2026-11-27", since: "2026-11", author: "benjaminshafii",
  docs: "docs/features/microsoft-365-read-resources/README.md", deployments: everywhere, default: false,
})
