import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: select several sessions in the sidebar",
  description: "Cmd/Ctrl-click adds a session to a selection and Shift-click selects a range, so several sessions can be archived, unarchived, pinned or moved to a group at once.",
  category: "experience",
  added: "2026-11-19",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/session-multi-select/README.md",
  deployments: everywhere,
  default: false,
})
