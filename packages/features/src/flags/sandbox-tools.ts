import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: sandbox tools",
  description: "Pilot local microsandbox tools with live workspace and Authorized Folders mounts. Adds guest command, read, write, edit, glob and grep tools; normal host tools are unchanged in this first slice. Sandbox-only replacement is not exposed until its permission and host-tool controls are complete. Runtime failures never fall back to host execution.",
  category: "computerUse",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/sandbox-tools/README.md",
  deployments: everywhere,
  default: false,
})
