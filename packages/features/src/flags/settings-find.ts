import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: find on a settings page",
  description: "In Settings, Cmd/Ctrl+F or the find button in the header finds text on the current page, highlights every match and moves between them.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/settings-find/README.md",
  deployments: everywhere,
  default: false,
})
