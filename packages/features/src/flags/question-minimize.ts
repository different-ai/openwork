import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: minimize a pending question",
  description: "When an agent asks a question, the person can minimize it to one line above the message box to read the conversation, then reopen it with everything they picked or typed still there. The question stays pending the whole time. Turning it off shows the question fully open, as before.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/question-minimize/README.md",
  deployments: everywhere,
  default: false,
})
