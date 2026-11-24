import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Your agent writes one message per check",
  description: "With Your agent's brief on, each check sends at most one message: the agent that did the reading writes it, as short paragraphs with the links in the sentences they support, instead of handing its findings to a second step that wrote several short alerts. Sources that need connecting are named in one plain message instead of one per connection.",
  category: "workbot",
  added: "2026-11-24",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/workbot-agent-one-message/README.md",
  deployments: everywhere,
  default: false,
})
