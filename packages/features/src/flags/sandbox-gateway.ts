import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: computers through the sandbox gateway",
  description: "Workbot's cloud computers for this organization run through the runner's sandbox gateway (Differently), which holds the provider keys and picks the provider, instead of the runner's own Freestyle or Daytona account. Needs a runner with SANDBOX_GATEWAY set; without one, or while it is down, new computers use the runner's own provider.",
  category: "computerUse",
  added: "2026-10-28",
  since: "2026-10",
  author: "reachjalil",
  docs: "docs/computer-use/workbot.md",
  deployments: everywhere,
  default: false,
})
