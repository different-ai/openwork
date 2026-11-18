import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Your agent's brief and check rhythm",
  description: "With Your agent on, it checks on one rhythm (every 2 hours in working hours by default, plus up to 3 extra checks it asks for) instead of four fixed message types, and follows a plain-text brief: the organization's default plus each member's own lines, set in Manage › Workbot, My bot or chat. Each check researches first and then writes at most a few short messages, each one finding with a lock-screen first sentence. Messages per day and hours stay hard limits.",
  category: "workbot",
  added: "2026-11-03",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/workbot-agent-brief/README.md",
  deployments: everywhere,
  default: false,
})
