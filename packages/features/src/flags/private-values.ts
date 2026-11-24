import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Private values the agent never sees",
  description: "The agent puts a password, token, one-time code or any other private value into a website, a program or one https request by naming a command that prints it, such as your password manager's, or by asking you to paste it. OpenWork fetches the value after you approve and delivers it; the agent and its model provider never see it.",
  category: "computerUse",
  added: "2026-11-23",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/private-values.md",
  deployments: everywhere,
  default: false,
})
