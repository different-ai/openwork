import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Connect: request only chosen scopes",
  description: "Admins can make a connection ask for only the scopes they list when people sign in, leaving out any others the server asks for.",
  category: "connect",
  added: "2026-11-16",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/connection-selected-scopes-only/README.md",
  deployments: everywhere,
  default: false,
})
