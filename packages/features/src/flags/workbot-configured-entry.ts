import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: configured deployment entry",
  description: "On self-hosted Den Web, an unconfigured Workbot entry returns not found instead of opening hosted Workbot. Explicit destinations still win.",
  category: "workbot",
  added: "2026-11-24",
  since: "2026-11",
  author: "yomgui",
  docs: "docs/features/workbot-configured-entry/README.md",
  deployments: ["self_hosted"],
  default: false,
})
