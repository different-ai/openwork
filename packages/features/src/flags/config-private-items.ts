import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Private items in Config migrations",
  description: "Organization Config exports include private plugins and skills. Config imports give invited members more time to join.",
  category: "administration",
  added: "2026-11-25",
  since: "2026-11",
  author: "yomgui",
  docs: "docs/features/config-private-items/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
