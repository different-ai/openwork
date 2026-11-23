import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Enable all connected sources in My bot",
  description: "Members can turn on their connected, selectable connectors together for proactive checks.",
  category: "workbot",
  added: "2026-11-23",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-proactive/README.md",
  deployments: everywhere,
  default: false,
})
