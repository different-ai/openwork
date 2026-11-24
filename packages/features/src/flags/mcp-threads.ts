import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Threads over MCP",
  description: "Start, follow and answer OpenWork sessions from any MCP client with standard tools, and hear about their changes through MCP Events instead of polling.",
  category: "connect",
  added: "2026-11-17",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/mcp-threads/README.md",
  deployments: everywhere,
  default: false,
})
