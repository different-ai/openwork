import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Computers through the sandbox gateway",
  description: "Use Differently for remote sandbox placement and provider credentials. Workbot needs a runner with SANDBOX_GATEWAY configured; without it, or during an infrastructure outage, new Workbot computers use the runner's own provider. Planned sandbox tools reuse this rollout for Remote access alongside sandboxTools, but fail closed without any direct-provider or local fallback. Local microsandbox does not need this rollout.",
  category: "computerUse",
  added: "2026-10-28",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/computer-use/workbot.md",
  deployments: everywhere,
  default: false,
})
