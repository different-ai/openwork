import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "OpenCode v2 only",
  description: "Desktop chats always run on OpenCode v2: switching to OpenCode v1 is turned off and earlier chats are copied to v2 in the background.",
  category: "experience",
  added: "2026-10-27",
  since: "2026-10",
  author: "benjaminshafii",
  docs: "docs/features/opencode-v2-only/README.md",
  deployments: everywhere,
  default: false,
})
