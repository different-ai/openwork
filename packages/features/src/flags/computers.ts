import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Computers",
  description: "Use your desktop chat's file and shell tools on your own registered cloud computer, and see one row per computer in Den.",
  category: "computerUse",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/computers/README.md",
  deployments: everywhere,
  default: false,
})
