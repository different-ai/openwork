import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "LiteLLM: member Microsoft Entra sign-in",
  description: "Admins can add a LiteLLM proxy that accepts sign-in tokens instead of LiteLLM keys (JWT auth): each person signs in with Microsoft once, and AI Gateway sends their own Entra access token to LiteLLM. Models come from a list the admin enters.",
  category: "models",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/litellm-entra-member-sign-in/README.md",
  deployments: everywhere,
  default: false,
})
