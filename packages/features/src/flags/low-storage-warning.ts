import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: low disk space warning",
  description: "When the computer running OpenWork is almost out of disk space, the app says how much is left and asks the person to free up space, before saving starts to fail.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/low-storage-warning/README.md",
  deployments: everywhere,
  default: false,
})
