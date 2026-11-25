import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "LiteLLM: verify Microsoft sign-in against the proxy",
  description: "Checks a member's new Microsoft Entra token against the LiteLLM proxy right after sign-in and warns if LiteLLM rejects it or hides configured models.",
  category: "models",
  added: "2026-11-24",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/litellm-entra-connect-check/README.md",
  deployments: everywhere,
  default: false,
})
