import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: calm chat look",
  description: "A quieter look for Workbot's chat: a labelled sidebar with the open page as a white pill, Workbot's name and live status in one pill at the top, a narrower conversation with smaller text, a compact browser card, and a softer message box. Looks only; chats, files, browser tasks and navigation work the same.",
  category: "workbot",
  added: "2026-11-12",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/workbot-calm-chat/README.md",
  deployments: everywhere,
  default: false,
})
