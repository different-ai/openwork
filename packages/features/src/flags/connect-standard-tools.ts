import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Connect: standard tools",
  description: "Claude Code and standalone OpenCode discover connected actions, Workflows and artifacts as individual tools; OpenWork Desktop, Web and automation runs keep capability search. Capability search uses MCP tool schemas with older fields kept for compatibility. Turning this off restores the previous search view and schemas.",
  category: "connect",
  added: "2026-10-21",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
