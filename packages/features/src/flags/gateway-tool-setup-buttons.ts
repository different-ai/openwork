import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "AI Gateway: set up other tools from My Library",
  description: "Library › Models shows \"Use OpenWork AI Gateway with other tools\" with a row of tool logos (Cursor, Codex, Claude Code, Claude Desktop and more). Each opens that tool's setup steps in a dialog, where the person can create a key that fills into every step. Turning it off restores the \"API keys for 3rd party tools\" section with its Set up Cursor link.",
  category: "models",
  added: "2026-11-13",
  since: "2026-11",
  author: "OmarMcAdam",
  docs: "docs/features/gateway-tool-setup-buttons/README.md",
  deployments: everywhere,
  default: false,
})
