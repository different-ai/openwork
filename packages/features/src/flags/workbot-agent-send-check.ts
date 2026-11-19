import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Your agent checks each message before sending",
  description: "With Your agent's brief on, admins can turn on Check each message before sending in Manage › Workbot. A fast second model then reads each message Your agent wrote against the brief and what the member was already told today, and holds a message the brief says to skip or that repeats one from today. It never writes, changes or adds a message, and when it can't answer the message is sent as before.",
  category: "workbot",
  added: "2026-11-10",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-agent-send-check/README.md",
  deployments: ["cloud"],
  default: false,
})
