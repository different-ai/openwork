import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: suggested follow-ups",
  description: "After a reply finishes, the empty message box can show a suggested next message in gray. Tab fills it in; typing anything else ignores it. A small model writes the suggestion, and nothing shows when it has no clear next step to offer.",
  category: "experience",
  added: "2026-11-11",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/follow-up-suggestions/README.md",
  deployments: everywhere,
  default: false,
})
