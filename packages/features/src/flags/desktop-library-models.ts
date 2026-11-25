import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: models in the Library",
  description: "The desktop Library gets a Models filter that lists the models your organization gives you, grouped by provider. Providers that need your own sign-in (Google, AWS, Microsoft or a key) show a Sign in button and count toward Needs sign-in; the rest show as Ready. Off, the Library shows no models.",
  category: "models",
  added: "2026-11-24",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/desktop-library-models/README.md",
  deployments: everywhere,
  default: false,
})
