import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Enforce free model safety cases",
  description: "Block included model requests for a verified provider deactivation or reviewed misuse. Enable for everyone on the deployment.",
  category: "models", added: "2026-11-23", since: "2026-11", author: "reachjalil",
  docs: "docs/features/free-auto-safety-cases/README.md", deployments: everywhere, default: false,
})
