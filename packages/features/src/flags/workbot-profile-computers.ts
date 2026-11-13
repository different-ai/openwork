import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Computers in its profile",
  description: "Moves the existing Devices entry into Workbot's profile as a Computers tab. The same member-scoped computers, status and Open actions remain available. Requires the profile sheet and Devices.",
  category: "workbot",
  added: "2026-11-12",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/workbot-profile-computers/README.md",
  deployments: everywhere,
  default: false,
})
