import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: settings in tabs",
  description: "Workbot's settings are split into three tabs, General, Agents and Data sources, instead of one long page: in Manage › Workbot and on the Workbot section of a team's page and Everyone's page. With Your agent's brief on, the Agents tab groups its rows (Messages, Schedule), uses switches for yes or no choices and explains each row in a tooltip. Turning it off restores the single page and its rows.",
  category: "workbot",
  added: "2026-11-10",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-settings-tabs/README.md",
  deployments: everywhere,
  default: false,
})
