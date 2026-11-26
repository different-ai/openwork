import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Remote task live sync and durable session binding",
  description: "Binds remote tasks to their parent chat in Den, keeps a short-lived 20-message transcript tail in Den MySQL for fast opens across restarts and devices, and streams status and tail updates over one live connection per window. Turning it off reverts to status polling and on-demand transcript reads without losing tasks or drafts.",
  category: "computerUse",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/remote-session-live-sync/README.md",
  deployments: everywhere,
  default: false,
})
