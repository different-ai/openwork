import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: Ollama under AI Providers",
  description: "Settings no longer lists Ollama as its own page in the sidebar. Instead, AI Providers has a Use Ollama button at the bottom that opens the same Ollama page. Turning it off brings back the Ollama entry in the sidebar, as before.",
  category: "models",
  added: "2026-11-13",
  since: "2026-11",
  author: "OmarMcAdam",
  docs: "docs/features/ollama-in-ai-providers/README.md",
  deployments: everywhere,
  default: false,
})
