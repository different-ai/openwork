import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Session and computer MCP events",
  description: "Subscribe to changes in your remote sessions and computers through MCP Events.",
  category: "connect", added: "2026-11-12", since: "2026-11", author: "reachjalil",
  docs: "docs/features/native-mcp-events/README.md", deployments: everywhere, default: false, outcomes: true,
})
