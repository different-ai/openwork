import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "MCP thread events",
  description: "Subscribe a hosted chat to signed webhook events from its connected MCP servers.",
  category: "connect",
  added: "2026-11-12",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/mcp-thread-events/README.md",
  deployments: everywhere,
  default: false,
  outcomes: true,
})
