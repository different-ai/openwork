import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Personal agents",
  description: "Private alpha, not officially supported yet: turned on for one organization at a time on request. A member sets up agents from chat. Each agent has a name, a brief and routines that run on a schedule in OpenWork Cloud. Every tool is Allow, Ask or Block, and a tool that changes something asks first. An agent can be shared with teammates as Manager or Collaborator, and each person's runs use their own connections. A manager's changes wait for the owner's yes. Admins see every agent in the dashboard and can pause it, cap its budget, move it to another owner, choose who can share agents and who an agent reaches, allow shared logins, and set rules and tool rules for all agents.",
  category: "workbot",
  added: "2026-11-23",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/personal-agents/README.md",
  deployments: ["cloud"],
  default: false,
})
