import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: sandbox tools",
  description: "The agent gets extra sandbox command, file and preview tools while its usual tools stay on this computer. Setup chooses a local microsandbox microVM or Remote through Differently, which holds provider keys and selects the remote pool. Remote also requires sandboxGateway. An unavailable sandbox is an error, never a switch to another backend or host execution.",
  category: "computerUse",
  added: "2026-11-17",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/sandbox-tools/README.md",
  deployments: everywhere,
  default: false,
})
