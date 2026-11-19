import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: side chat answers from the conversation",
  description: "A side chat asks quick questions about the conversation on screen and is answered from what that conversation already knows, in a panel beside it. Nothing is added to the conversation, no tools run and no new session appears in the sidebar. /btw in the message box asks one too.",
  category: "experience",
  added: "2026-11-17",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/side-questions/README.md",
  deployments: everywhere,
  default: false,
})
