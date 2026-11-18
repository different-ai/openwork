import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Deployments: guided AWS approval",
  description: "Each deployment opens as its own page with the approval steps in order, a copyable approval link and what to do when AWS shows something else. Admins can save the organization's AWS access portal so every AWS link signs in to the right account first.",
  category: "administration",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/managed-deployment-aws-sign-in/README.md",
  deployments: ["cloud"],
  default: false,
})
