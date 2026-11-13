import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Remote desktop device sign-in",
  description: "Sign a remote OpenWork desktop into an organization by approving a code on another computer.",
  category: "experience",
  added: "2026-11-09",
  since: "2026-11",
  author: "yomgui",
  docs: "docs/features/remote-desktop-device-login/README.md",
  deployments: everywhere,
  default: false,
})
