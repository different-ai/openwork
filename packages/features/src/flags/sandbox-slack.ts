import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Sandboxes: sample Slack for Workbot",
  description: "New sandbox organizations get a sample Slack: a Slack connector at the sandbox's sample work apps with the Workbot Slack app already installed, so Proactive Mode can be turned on and each person's agent messages arrive on their own sample Slack page. Each person connects Slack once in their own browser. Only sandbox organizations are affected; every other organization keeps real Slack. Turning it off stops the sample Slack without sending anything to Slack.",
  category: "connect",
  added: "2026-11-11",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/sandbox-slack/README.md",
  deployments: ["cloud"],
  default: false,
})
