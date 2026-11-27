import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Cloud coding",
  description: "In Workbot, Slack and OpenWork Web, people ask OpenWork to change code. The work runs on the chat's own cloud computer, every push waits for the person who asked, and the pull request opens in their own GitHub name. An admin connects GitHub once from Cloud coding in Den; each person links their own GitHub account. Not offered in the desktop app.",
  category: "connect",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/cloud-coding/README.md",
  deployments: ["cloud"],
  default: false,
})
