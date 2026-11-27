import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Computers",
  description: "Workbot can run a command in the sandbox on a member's own computer, with only the folders the owner shared.",
  category: "computerUse",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/computers/README.md",
  deployments: everywhere,
  default: false,
})
