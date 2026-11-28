import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Slack: tables, buttons and sections in messages from OpenWork",
  description: "Messages the OpenWork app posts in Slack (answers in a thread, results from background tasks and the desktop, messages an agent or Automation sends with slack_send_as_bot, and Your agent's notes) can use Slack's own components: real tables, headers, dividers, small context lines, two-column fields, images, link buttons, and buttons the person clicks to answer a question. Off, every message is sent as text exactly as before.",
  category: "connect",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/slack-rich-messages/README.md",
  deployments: everywhere,
  default: false,
})
