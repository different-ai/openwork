import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: computer use on remote computers",
  description: "Use a Linux cloud computer with its browser and desktop in OpenWork Web, or connect a VM from Desktop. Configured and conversation-owned desktops open directly when enabled, including follow-ups and internal session renewal. Take over and Stop stay available.",
  category: "computerUse",
  added: "2026-10-20",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
