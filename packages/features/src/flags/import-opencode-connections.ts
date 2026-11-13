import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: import connections from OpenCode",
  description: "Settings shows how many connections a person set up in their own OpenCode config are not in OpenWork, with an Import from OpenCode action. Importing copies them into OpenWork once, like adding each by hand, then shows each one's real state and anything that was left out. The person's OpenCode files are never changed. Off, Settings does not look at the OpenCode config.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/import-opencode-connections/README.md",
  deployments: everywhere,
  default: false,
})
