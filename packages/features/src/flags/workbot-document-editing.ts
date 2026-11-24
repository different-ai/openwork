import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot Documents: editing",
  description: "Members choose Edit from a document preview. Full Office editing starts their Cloud workspace only when requested. Requires Workbot Documents.",
  category: "workbot",
  added: "2026-10-20",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
