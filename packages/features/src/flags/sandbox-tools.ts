import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: sandbox tools",
  description: "The agent gets extra tools that run commands, read and write files and preview a web app inside an isolated sandbox: a local microVM on this computer, or a cloud sandbox the organization chose. Its usual tools keep working on this computer. When the sandbox cannot start, the tools say so and nothing runs on this computer in its place.",
  category: "computerUse",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/sandbox-tools/README.md",
  deployments: everywhere,
  default: false,
})
