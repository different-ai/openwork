import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Connect: a tool for each action in OpenWork's engine",
  description: "OpenWork Desktop, Web and automation runs get each connected action, Workflow and artifact as its own tool, found with their engine's Code Mode search; capability search stays for OpenWork's own operations and skills. Other clients are unaffected. Turning this off restores capability search.",
  category: "connect",
  added: "2026-10-28",
  since: "2026-10",
  author: "reachjalil",
  docs: "docs/features/connect-engine-tools/README.md",
  deployments: everywhere,
  default: false,
})
