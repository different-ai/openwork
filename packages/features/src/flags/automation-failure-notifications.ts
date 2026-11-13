import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Automations: notify when a run fails or is missed",
  description: "When one of your Automations fails, including when a connection it needs must be reconnected, the OpenWork app tells you once: an entry in its notification center and, while the app is in the background, a system notification. When a run is missed because no desktop was connected, it offers to run it now or to move its schedule to the cloud.",
  category: "automations",
  added: "2026-11-04",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/automation-failure-notifications/README.md",
  deployments: everywhere,
  default: false,
})
