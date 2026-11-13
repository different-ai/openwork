import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Sandboxes: choose each sandbox's models",
  description: "A platform admin picks which AI Gateway models a new sandbox organization gets when creating it, instead of every sandbox getting the deployment's list. Sandboxes that already exist keep their models. Turning this off gives new sandboxes the deployment's list again.",
  category: "models",
  added: "2026-11-11",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/sandbox-model-choice/README.md",
  deployments: ["cloud"],
  default: false,
})
