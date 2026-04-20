const home = `# OpenWork

> The open-source Claude Cowork alternative. OpenWork is a desktop app that lets teams chat with 50+ LLMs, bring their own provider keys, and ship reusable agent setups with guardrails.

## What it is

- Desktop app (macOS, Windows, Linux) — GUI for OpenCode
- Bring your own model and provider (OpenAI, Anthropic, local models, 50+ supported)
- Skills, plugins, and MCP servers extend what the agent can do
- Shared agent setups for teams, with policy and guardrails
- Free and open source

## Primary calls-to-action

- **Try it free** — [Download the desktop app](https://openworklabs.com/download)
- **Hosted cloud workers** — [Pricing](https://openworklabs.com/pricing) (\\$50/mo per worker)
- **Sign in to the hosted workspace** — [Cloud](https://app.openworklabs.com)
- **SSO / audit / procurement** — [Enterprise](https://openworklabs.com/enterprise)
- **Docs** — [openworklabs.com/docs](https://openworklabs.com/docs)

## For agents

- Agent skills index — \`/.well-known/agent-skills/index.json\`
- llms.txt — \`/llms.txt\`
- API catalog (RFC 9727) — \`/.well-known/api-catalog\`
- Sitemap — \`/sitemap.xml\`

Backed by Y Combinator.
`

const pricing = `# OpenWork pricing — free, team, and enterprise

> OpenWork has three tiers: free open-source desktop, \\$50/mo Team Starter, and custom Enterprise.

## Solo — \\$0

- Open-source desktop app
- macOS, Windows, Linux downloads
- Bring your own provider keys
- Free forever
- CTA: [Download](https://openworklabs.com/download)

## Team Starter — \\$50 / month

- 5 seats included
- API access
- Skill Hub Manager
- Bring your own LLM keys, distributed to your team
- CTA: [Start team plan](https://app.openworklabs.com/checkout)

## Enterprise — Custom pricing

- Enterprise rollout support
- Deployment guidance
- Custom commercial terms
- For org-wide rollout and custom terms
- CTA: [Talk to us](https://openworklabs.com/enterprise#book)

Prices exclude taxes.
`

const enterprise = `# A privacy-first alternative to Claude Cowork for your organization

> The open-source Claude Cowork alternative — self-hosted, permissioned, and compliance-ready. SSO, audit, custom deployment, and procurement support.

## What Enterprise includes

- Enterprise rollout support and deployment guidance
- Custom commercial terms
- SSO / SAML integration
- Audit logs and policy controls
- Named security contact and incident response

## Deployment models

- Self-hosted desktop app — data stays local, bring your own keys
- Cloud workers — managed by OpenWork, sandbox infrastructure via Daytona (EU)

## Next step

- [Book a call](https://openworklabs.com/enterprise#book)
- [Security Review](https://openworklabs.com/trust) — data handling, subprocessors, and incident SLA
- See [Pricing](https://openworklabs.com/pricing) for tier comparison
`

const download = `# Download OpenWork

> Desktop app for macOS, Windows, and Linux. Latest release published on GitHub.

## macOS

- **Apple Silicon (M-series)** — recommended for M1/M2/M3/M4. \`.dmg\`
- **Intel (x64)** — for Intel-based Macs. \`.dmg\`

## Windows

- **x64** — MSI installer

## Linux

- **Arch / AUR** — \`yay -S openwork\` (or \`paru -S openwork\`)
- **Ubuntu / Debian** — \`.deb\` for x64 and arm64
- **Fedora / RHEL / openSUSE** — \`.rpm\` for x64 and arm64

Direct download URLs resolve from the latest GitHub release. Browse all assets at [github.com/openworklabs/openwork/releases/latest](https://github.com/openworklabs/openwork/releases/latest).

## After installing

Once the desktop app is running, use the [workspace-guide skill](https://openworklabs.com/.well-known/agent-skills/workspace-guide/SKILL.md) for first-run orientation.
`

const trust = `# Trust & Security

> How OpenWork handles data, what subprocessors are involved, and how to reach the security team.

## Key facts

- **Deployment** — self-hosted desktop app on your machines
- **Data storage** — local-only, nothing leaves your machine in desktop mode
- **LLM keys** — bring your own, sent directly to your provider
- **Telemetry** — none in desktop mode; opt-in feedback only
- **Incident SLA** — 72hr notify, 3-day ack, 7-day triage
- **Subprocessors** — 5 named vendors (cloud & website only)

## Data handling

| Data type | Self-hosted | Cloud |
|---|---|---|
| Source code | Local only | Accessed at runtime via your LLM provider; not stored |
| LLM API keys | Local keychain / env vars | Held by your LLM provider, not by OpenWork |
| Prompts & responses | Local only | Sent to your LLM provider; not logged by OpenWork |
| Usage telemetry | None | Anonymous via PostHog; can be disabled |
| Authentication | Your SSO / SAML | Google or GitHub OAuth |

## Subprocessors

- PostHog — analytics (US/EU)
- Polar — billing (US)
- Google — OAuth (US)
- GitHub — OAuth (US)
- Daytona — cloud sandbox infrastructure (EU)

## Security contact

Omar McAdam — team+security@openworklabs.com
`

export const agentMarkdown: Record<string, string> = {
  "/": home,
  "/pricing": pricing,
  "/enterprise": enterprise,
  "/download": download,
  "/trust": trust,
}

export const agentMarkdownRoutes = Object.keys(agentMarkdown)
