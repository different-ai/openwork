import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: context and connectors in the chat box",
  description: "Next to the model picker, people see how full the model's context is, with a breakdown of what fills it, and which connectors are connected.",
  category: "experience",
  added: "2026-11-21",
  since: "2026-11",
  author: "m-froehlich",
  docs: "docs/features/composer-context-indicators/README.md",
  deployments: everywhere,
  default: false,
})
