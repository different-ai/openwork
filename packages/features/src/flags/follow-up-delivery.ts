import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: follow-up delivery status",
  description: "A message sent while the agent is working shows that it is waiting for the current step to finish until the agent reads it. While you type, the message box shows which key sends when the agent finishes and which sends right away.",
  category: "experience",
  added: "2026-11-16",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/follow-up-delivery/README.md",
  deployments: everywhere,
  default: false,
})
