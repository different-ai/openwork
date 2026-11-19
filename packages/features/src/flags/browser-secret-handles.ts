import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Browser: secret handles",
  description: "Save a password, one-time code or token for a conversation and choose the sites it may go to. The agent fills it in the built-in browser on those sites without ever seeing it, and asks you before each fill.",
  category: "computerUse",
  added: "2026-11-18",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/browser/secret-handles.md",
  deployments: everywhere,
  default: false,
})
