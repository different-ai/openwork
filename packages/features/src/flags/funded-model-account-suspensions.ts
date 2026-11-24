import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Enforce funded model account suspensions",
  description: "Restrict OpenWork-funded model access across organizations following a reviewed provider request.",
  category: "models", added: "2026-11-23", since: "2026-11", author: "reachjalil",
  docs: "docs/features/funded-model-account-suspensions/README.md", deployments: everywhere, default: false,
})
