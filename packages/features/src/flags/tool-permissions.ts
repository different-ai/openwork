import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Tool permissions",
  description: "Private alpha, not officially supported yet. Admins set each tool of a connection to Allow, Ask or Block for the whole organization, a team or one person. With no rule, a tool that only reads is allowed and a tool that changes something asks first. Applies to chats, Automations, Workbot and agents. A tool that asks is refused until the person it ran for says yes, once.",
  category: "connect",
  added: "2026-11-25",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/tool-permissions/README.md",
  deployments: ["cloud"],
  default: false,
})
