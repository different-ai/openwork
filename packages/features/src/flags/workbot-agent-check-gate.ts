import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Your agent skips checks when nothing new arrived",
  description: "With Your agent's brief on, admins can turn on Skip checks when nothing new arrived in Manage › Workbot. Before a scheduled check, Workbot looks at what reached the member's Gmail and Google Calendar since the agent last looked. With nothing new, or only routine mail, the agent doesn't run for that check. The first check of the day, checks the agent asked for, and a check after two skipped in a row always run.",
  category: "workbot",
  added: "2026-11-10",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-agent-check-gate/README.md",
  deployments: ["cloud"],
  default: false,
})
