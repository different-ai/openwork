import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: run commands from the chat",
  description: "A one-line command the agent suggests in a shell block gets a Run button next to Copy. Clicking it asks the agent to run that exact command in the conversation's workspace, so the output appears as a step in the chat and the agent continues from the result. Turning it off leaves the blocks copy-only.",
  category: "experience",
  added: "2026-11-19",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/chat-run-commands/README.md",
  deployments: everywhere,
  default: false,
})
