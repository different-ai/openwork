import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "AI Gateway: OpenCode setup",
  description: "OpenCode joins Cursor, Codex and Claude Code under Set up in My Library › Models: members get an opencode.json with their OpenWork models, ready to copy.",
  category: "models",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/gateway-open-code-setup/README.md",
  deployments: everywhere,
  default: false,
})
