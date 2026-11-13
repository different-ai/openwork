import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: workspace assistant",
  description: "Members ask Workbot about the document they have open (Ask Workbot brings it into the chat) and navigate from a compact sidebar. Workbot offers to open the documents it mentions. The chat itself stays on its own page.",
  category: "workbot",
  added: "2026-10-16",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
