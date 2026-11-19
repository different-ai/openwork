import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "AI Gateway: OpenCode setup",
  description: "Show members how to install the OpenWork plugin for OpenCode 2 and sign in from My Library › Models.",
  category: "models",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/gateway-open-code-setup/README.md",
  deployments: everywhere,
  default: false,
})
