import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Deploy-time administrator recovery",
  description: "Run a one-time, operator-selected Admin-team permission repair at deployment; disabling stops future repairs, not existing grants.",
  category: "administration",
  added: "2026-10-23",
  since: "2026-10",
  author: "yomgui",
  deployments: everywhere,
  default: false,
})
