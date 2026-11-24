import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Connect: an MCP server for each connection",
  description: "Members can add one connected service, such as Gmail or Linear, to an agent like Claude Code as its own MCP server that lists only that service's tools.",
  category: "connect",
  added: "2026-10-21",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
