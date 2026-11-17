import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: phone app",
  description: "Members can sign in to the OpenWork app on iPhone and use Workbot there. Needs Workbot.",
  category: "workbot",
  added: "2026-11-16",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-mobile/README.md",
  deployments: everywhere,
  default: false,
})
