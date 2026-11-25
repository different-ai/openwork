import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: follow the computer's proxy settings",
  description: "On a network that only allows traffic through a company proxy, connectors, the person's own model providers, web fetches and commands the agent runs use the same proxy the computer is set to, including automatic (PAC) settings. Nothing to set up on the computer.",
  category: "experience",
  added: "2026-11-19",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/desktop-system-proxy/README.md",
  deployments: everywhere,
  default: false,
})
