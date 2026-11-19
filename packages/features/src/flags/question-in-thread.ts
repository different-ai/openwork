import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: questions in the conversation",
  description: "When an agent asks a question, it shows as a card at the end of the conversation instead of above the message box, so the person can scroll and keep typing. Sending a message from the message box skips the question. Off, the question opens above the message box, as before.",
  category: "experience",
  added: "2026-11-18",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/question-in-thread/README.md",
  deployments: everywhere,
  default: false,
})
