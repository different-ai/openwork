import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: teach browser tasks",
  description: "Demonstrate a browser task with explanations, save it as a private reusable skill, and run it with new inputs.",
  category: "computerUse",
  added: "2026-10-21",
  since: "2026-10",
  author: "reachjalil",
  docs: "docs/computer-use/browser-demonstrations.md",
  deployments: everywhere,
  default: false,
})
