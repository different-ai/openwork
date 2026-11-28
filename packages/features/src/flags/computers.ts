import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Computers",
  description: "Use a chat's file and shell tools on your other computers: another laptop through its sandbox, or your registered cloud computer. Den shows one row per computer.",
  category: "computerUse",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/computers/README.md",
  deployments: everywhere,
  default: false,
})
