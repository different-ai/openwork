import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Bedrock guardrails",
  description: "Apply an organization-managed AWS guardrail to Bedrock Runtime requests.",
  category: "administration",
  added: "2026-11-25",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/bedrock-guardrails/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
