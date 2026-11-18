import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: sandbox tools",
  description: "Pilot local microsandbox command and file tools with live workspace and Authorized Folders mounts. Turn off host tools in Permissions to require sandbox-only execution; organization restrictions take precedence. Required mode disables apps, browser and MCP tools and ignores project configuration. Needs the supported v2 engine and local runtime. Failures never fall back to the host.",
  category: "computerUse",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/sandbox-tools/README.md",
  deployments: everywhere,
  default: false,
})
