import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot Documents",
  description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, play video and audio files in the tab, and save supported text and spreadsheet edits to Drive.",
  category: "workbot",
  added: "2026-10-16",
  since: "2026-10",
  author: "reachjalil",
  deployments: everywhere,
  default: false,
})
