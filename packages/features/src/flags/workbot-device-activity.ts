import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: activity on Devices",
  description: "Each computer in Workbot's Devices list says what Workbot is doing there now: a task running on one of the person's own computers, a task waiting on them, or Workbot working in the chat its own computer belongs to. Requires Devices.",
  category: "workbot",
  added: "2026-11-13",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-device-activity/README.md",
  deployments: everywhere,
  default: false,
})
