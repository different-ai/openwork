import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Den: team sections in a sidebar",
  description: "On Members › Teams, a team's page and Everyone's page list their sections (Role, Members, Access, Agents, Browser, Models, Workbot, Prompts, Desktop) in a grouped sidebar on the left instead of a row of tabs across the top. The Role, Agents and Browser sections get a heading with a tooltip that explains them, and a role that adds nothing says so. Turning it off restores the tabs and the earlier sections.",
  category: "administration",
  added: "2026-11-10",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/team-settings-sidebar/README.md",
  deployments: everywhere,
  default: false,
})
